// Buyer contact details → Stripe Customer.
//
// Stripe Checkout prefills the email field from the Customer attached to the
// session (`customer_email` is rejected alongside `customer`), and in
// payment/subscription mode it prefills the saved card's name and address too.
// So the lever for a smooth checkout is not a session parameter — it is having
// a properly populated Customer before the session is created. This module
// owns that, and is the only place that writes buyer PII to Stripe.
//
// Ownership model, which the rules below encode:
//   • A tenant is an ORGANISATION (an agency workspace), and its Stripe
//     Customer is the organisation's billing account. Several staff members
//     buy against the same Customer.
//   • `Customer.name` is therefore the ORG name, never a person's — invoices
//     must read "NPC Services Pty Ltd", not whoever happened to click Buy.
//   • `Customer.email` is the org's billing address. It is SEEDED from the
//     first buyer we see and then left alone: silently repointing an
//     organisation's billing email because a different colleague made a
//     purchase would send their invoices to the wrong inbox.
//   • The individual buyer is still captured — on Customer metadata (for
//     support lookups) and, per purchase, as the receipt email — so nobody
//     loses their own receipt to the shared org address.
import type Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";

export type BillingContact = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  phone: string | null;
  company: string | null;
};

export const EMPTY_CONTACT: BillingContact = {
  email: null,
  firstName: null,
  lastName: null,
  fullName: null,
  phone: null,
  company: null,
};

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  // Strip control characters and collapse whitespace — these end up in Stripe
  // metadata and on customer-visible invoices.
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/**
 * A permissive but real email check. Stripe rejects malformed addresses with a
 * 400, which would turn "we tried to be helpful" into "checkout is broken", so
 * anything that doesn't look like an address is dropped rather than sent.
 */
function cleanEmail(value: unknown): string | null {
  const raw = clean(value, 320);
  if (!raw) return null;
  const email = raw.toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) return null;
  return email;
}

/** Normalise any caller-supplied shape into the canonical contact block. */
export function normalizeBillingContact(raw: unknown): BillingContact {
  const r = (raw ?? {}) as Record<string, unknown>;
  const firstName = clean(r.firstName ?? r.first_name, 100);
  const lastName = clean(r.lastName ?? r.last_name, 100);
  const explicitFull = clean(r.fullName ?? r.full_name ?? r.name, 200);
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();

  return {
    email: cleanEmail(r.email),
    firstName,
    lastName,
    fullName: explicitFull ?? (joined || null),
    phone: clean(r.phone, 40),
    company: clean(r.company ?? r.organisation ?? r.organization, 200),
  };
}

export function hasContactDetail(contact: BillingContact | null | undefined): boolean {
  if (!contact) return false;
  return Boolean(
    contact.email || contact.fullName || contact.firstName || contact.lastName || contact.phone,
  );
}

/** Contact block as stored on a `billing_handoffs` row. */
export function contactFromHandoffRow(row: Record<string, unknown> | null): BillingContact {
  if (!row) return EMPTY_CONTACT;
  return normalizeBillingContact({
    email: row.contact_email,
    first_name: row.contact_first_name,
    last_name: row.contact_last_name,
    phone: row.contact_phone,
    company: row.contact_company,
  });
}

/**
 * Buyer identity for Stripe metadata. Kept flat and short — Stripe caps
 * metadata at 50 keys and 500 characters per value.
 */
export function contactMetadata(contact: BillingContact): Record<string, string> {
  const meta: Record<string, string> = {};
  if (contact.email) meta.buyer_email = contact.email;
  if (contact.fullName) meta.buyer_name = contact.fullName;
  if (contact.firstName) meta.buyer_first_name = contact.firstName;
  if (contact.lastName) meta.buyer_last_name = contact.lastName;
  if (contact.phone) meta.buyer_phone = contact.phone;
  if (contact.company) meta.buyer_company = contact.company;
  return meta;
}

export type CustomerContactSync = {
  /** Fields actually written to Stripe (empty when nothing needed changing). */
  applied: string[];
  /** The email Checkout will prefill — the Customer's, after any seeding. */
  effectiveEmail: string | null;
};

/**
 * Bring a Stripe Customer up to date from a buyer's contact block.
 *
 * Only ever FILLS BLANKS on the shared identity fields (email, phone, name);
 * metadata is refreshed every time so support can see who bought most
 * recently. Best-effort by contract: a failure here must never block a
 * purchase, so the caller gets a result object rather than an exception.
 */
export async function syncStripeCustomerContact(
  customerId: string,
  contact: BillingContact,
  opts: { orgName?: string | null } = {},
): Promise<CustomerContactSync> {
  const result: CustomerContactSync = { applied: [], effectiveEmail: null };

  let customer: Stripe.Customer | Stripe.DeletedCustomer;
  try {
    customer = await getStripe().customers.retrieve(customerId);
  } catch (err) {
    console.warn("[billing-contact] customer retrieve failed", err);
    return result;
  }
  if (customer.deleted) return result;

  const current = customer as Stripe.Customer;
  result.effectiveEmail = current.email ?? null;

  const update: Stripe.CustomerUpdateParams = {};

  // Seed-only: an organisation's billing email is not a per-purchase field.
  if (!current.email && contact.email) {
    update.email = contact.email;
    result.applied.push("email");
    result.effectiveEmail = contact.email;
  }
  if (!current.phone && contact.phone) {
    update.phone = contact.phone;
    result.applied.push("phone");
  }
  // Org name, in preference order: what the tenant is called, else the buyer's
  // stated company. A person's name is deliberately NOT a candidate.
  const orgName = clean(opts.orgName, 200) ?? contact.company;
  if (!current.name && orgName) {
    update.name = orgName;
    result.applied.push("name");
  }

  // Metadata always reflects the latest buyer — it is diagnostic, not billing.
  const nextMeta = contactMetadata(contact);
  if (Object.keys(nextMeta).length > 0) {
    const existingMeta = (current.metadata ?? {}) as Record<string, string>;
    const changed = Object.entries(nextMeta).some(([k, v]) => existingMeta[k] !== v);
    if (changed) {
      update.metadata = { ...existingMeta, ...nextMeta };
      result.applied.push("metadata");
    }
  }

  if (result.applied.length === 0) return result;

  try {
    await getStripe().customers.update(customerId, update);
  } catch (err) {
    // Never let a prefill nicety break a purchase.
    console.warn("[billing-contact] customer update failed", err);
    return { applied: [], effectiveEmail: current.email ?? null };
  }
  return result;
}
