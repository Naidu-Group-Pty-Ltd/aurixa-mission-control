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
import { asRow } from "@/lib/json-cast";
import type { TablesUpdate } from "@/integrations/supabase/types";
import type Stripe from "stripe";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { getStripe } from "@/server/stripe.server";
import { AURIXA_INVOICE_FOOTER, AURIXA_INVOICE_RENDERING } from "@/lib/brand/aurixa-brand";

export type BillingContact = {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  phone: string | null;
  company: string | null;
  /** Stripe tax ID type, e.g. 'au_abn'. Null unless taxIdValue is set. */
  taxIdType: string | null;
  /** Normalised, checksum-valid tax ID (ABN digits only). */
  taxIdValue: string | null;
};

export const EMPTY_CONTACT: BillingContact = {
  email: null,
  firstName: null,
  lastName: null,
  fullName: null,
  phone: null,
  company: null,
  taxIdType: null,
  taxIdValue: null,
};

/** Metadata key recording the workspace name Mission Control last wrote to
 *  `Customer.name`, so a later rename can be distinguished from an operator
 *  editing the name by hand in the Stripe dashboard. */
export const WORKSPACE_NAME_META_KEY = "workspace_name";

// Control characters would otherwise reach Stripe metadata and customer-visible
// invoices, so matching them here is the point.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
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

// ── Australian Business Number ──────────────────────────────────────────────

/**
 * ATO checksum for an 11-digit ABN: subtract 1 from the leading digit, apply
 * the standard positional weights, and the weighted sum must be divisible
 * by 89.
 *
 * This matters more than it looks. Stripe stops showing the tax-ID form once a
 * Customer has ANY tax ID saved, so pre-attaching a malformed ABN would both
 * put a junk number on the invoices and remove the buyer's chance to correct
 * it. An ABN that fails here is dropped and Checkout asks for one instead.
 */
const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];

export function isValidAbn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const digit = Number(digits[i]) - (i === 0 ? 1 : 0);
    if (digit < 0) return false;
    sum += digit * ABN_WEIGHTS[i];
  }
  return sum % 89 === 0;
}

/** Strip formatting from an ABN: "51 824 753 556" → "51824753556". */
export function normalizeAbn(value: string): string {
  return value.replace(/\D/g, "");
}

type NormalizedTaxId = { type: string; value: string } | null;

/**
 * Accept a tax ID only when we can vouch for it. Australia is the only type we
 * validate locally today; anything else is passed through on the caller's
 * explicit `tax_id_type` so a future region needs no change here, and a bare
 * number with no type is assumed to be an ABN (the product's home market).
 */
function normalizeTaxId(rawValue: unknown, rawType: unknown): NormalizedTaxId {
  const value = clean(rawValue, 50);
  if (!value) return null;
  const type = clean(rawType, 32)?.toLowerCase() ?? "au_abn";

  if (type === "au_abn") {
    const digits = normalizeAbn(value);
    return isValidAbn(digits) ? { type, value: digits } : null;
  }
  // Other Stripe tax-ID types (eu_vat, gb_vat, nz_gst, …) are validated by
  // Stripe on attach; we only guard the length.
  return { type, value };
}

/** Normalise any caller-supplied shape into the canonical contact block. */
export function normalizeBillingContact(raw: unknown): BillingContact {
  const r = (raw ?? {}) as Record<string, unknown>;
  const firstName = clean(r.firstName ?? r.first_name, 100);
  const lastName = clean(r.lastName ?? r.last_name, 100);
  const explicitFull = clean(r.fullName ?? r.full_name ?? r.name, 200);
  const joined = [firstName, lastName].filter(Boolean).join(" ").trim();
  const taxId = normalizeTaxId(
    r.taxIdValue ?? r.tax_id ?? r.taxId ?? r.abn,
    r.taxIdType ?? r.tax_id_type,
  );

  return {
    email: cleanEmail(r.email),
    firstName,
    lastName,
    fullName: explicitFull ?? (joined || null),
    phone: clean(r.phone, 40),
    company: clean(r.company ?? r.organisation ?? r.organization, 200),
    taxIdType: taxId?.type ?? null,
    taxIdValue: taxId?.value ?? null,
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
    tax_id: row.contact_tax_id,
    tax_id_type: row.contact_tax_id_type,
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
  if (contact.taxIdValue) meta.buyer_tax_id = `${contact.taxIdType}:${contact.taxIdValue}`;
  return meta;
}

export type CustomerContactSync = {
  /** Fields actually written to Stripe (empty when nothing needed changing). */
  applied: string[];
  /** The email Checkout will prefill — the Customer's, after any seeding. */
  effectiveEmail: string | null;
  /** True when this call attached a tax ID the Customer did not have. */
  taxIdAttached: boolean;
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
  const result: CustomerContactSync = { applied: [], effectiveEmail: null, taxIdAttached: false };

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
  // Company name on the Stripe Customer — what appears on every tax invoice.
  // It is the WORKSPACE name, not a person's: the tenant's display name, or
  // failing that the buyer's stated company.
  //
  // Overwrite rules, so a rename propagates without stomping a human:
  //   • blank                                   → set it
  //   • still the workspace name we last wrote  → we own it, keep it current
  //   • a placeholder we generated              → upgrade it
  //   • anything else                           → an operator set it; leave alone
  const orgName = clean(opts.orgName, 200) ?? contact.company;
  const existingMetaForName = (current.metadata ?? {}) as Record<string, string>;
  if (orgName && current.name !== orgName) {
    const weWroteIt = existingMetaForName[WORKSPACE_NAME_META_KEY] === current.name;
    const isPlaceholder =
      !current.name ||
      current.name === (existingMetaForName.external_ref ?? "") ||
      /^tenant_[0-9a-f]{8}$/i.test(current.name);
    if (weWroteIt || isPlaceholder) {
      update.name = orgName;
      result.applied.push("name");
    }
  }

  // Invoice presentation — the footer and the tax display on every invoice this
  // Customer is ever sent, including subscription cycle invoices, which are
  // minted by Stripe with no request of ours to hang settings off.
  //
  // Unlike the identity fields above, this is OUR copy rather than the buyer's,
  // so it is kept CURRENT rather than seeded once: a workspace that bought
  // before the branding cutover would otherwise carry a blank footer forever.
  // Only these two sub-fields are sent — Stripe merges `invoice_settings`
  // field by field, which is the same behaviour payment-methods.server.ts
  // already relies on when it sets `default_payment_method` on its own.
  const invoiceSettings = (current.invoice_settings ?? {}) as {
    footer?: string | null;
    rendering_options?: { amount_tax_display?: string | null } | null;
  };
  if (
    invoiceSettings.footer !== AURIXA_INVOICE_FOOTER ||
    invoiceSettings.rendering_options?.amount_tax_display !==
      AURIXA_INVOICE_RENDERING.amount_tax_display
  ) {
    update.invoice_settings = {
      footer: AURIXA_INVOICE_FOOTER,
      rendering_options: { ...AURIXA_INVOICE_RENDERING },
    };
    result.applied.push("invoice_settings");
  }

  // Metadata always reflects the latest buyer — it is diagnostic, not billing.
  const nextMeta: Record<string, string> = { ...contactMetadata(contact) };
  // Record the workspace name we wrote, so the next sync can tell "renamed
  // upstream" from "an operator edited this in the Stripe dashboard".
  const ownedName = update.name ?? (orgName && current.name === orgName ? orgName : undefined);
  if (ownedName) nextMeta[WORKSPACE_NAME_META_KEY] = ownedName;

  if (Object.keys(nextMeta).length > 0) {
    const existingMeta = (current.metadata ?? {}) as Record<string, string>;
    const changed = Object.entries(nextMeta).some(([k, v]) => existingMeta[k] !== v);
    if (changed) {
      update.metadata = { ...existingMeta, ...nextMeta };
      result.applied.push("metadata");
    }
  }

  if (result.applied.length > 0) {
    try {
      await getStripe().customers.update(customerId, update);
    } catch (err) {
      // Never let a prefill nicety break a purchase.
      console.warn("[billing-contact] customer update failed", err);
      return { applied: [], effectiveEmail: current.email ?? null, taxIdAttached: false };
    }
  }

  result.taxIdAttached = await attachTaxIdIfAbsent(customerId, current, contact);
  return result;
}

/**
 * Pre-attach the workspace's known ABN so the buyer never types it.
 *
 * Stripe hides the tax-ID form entirely once a Customer has one saved, so this
 * is deliberately additive-only: we attach when the Customer has NO tax ID,
 * and otherwise leave whatever is there. That also means a stale or wrong ABN
 * can only ever come from a value that already passed `isValidAbn`, and an
 * operator can correct it in Stripe without this re-adding the old one.
 */
async function attachTaxIdIfAbsent(
  customerId: string,
  current: Stripe.Customer,
  contact: BillingContact,
): Promise<boolean> {
  if (!contact.taxIdValue || !contact.taxIdType) return false;

  try {
    const existing = await getStripe().customers.listTaxIds(customerId, { limit: 1 });
    if (existing.data.length > 0) return false;

    await getStripe().customers.createTaxId(customerId, {
      type: contact.taxIdType as Stripe.CustomerCreateTaxIdParams.Type,
      value: contact.taxIdValue,
    });
    return true;
  } catch (err) {
    // An unknown type or a value Stripe rejects simply means the buyer gets
    // asked on the checkout page, which is the pre-existing behaviour.
    console.warn("[billing-contact] tax id attach failed", err);
    return false;
  }
}

/**
 * Mirror the tax ID a completed Checkout Session collected onto the tenant.
 *
 * Stripe stays authoritative — this is a local copy so operators can see the
 * ABN in Mission Control, and so a later checkout can tell that the workspace
 * already has one. Additive: a session that collected nothing leaves whatever
 * is on file untouched, because Checkout hides the form once a tax ID exists
 * and every subsequent session would otherwise look like "they removed it".
 */
export async function recordTenantTaxIdFromSession(
  tenantId: string,
  customerDetails: Stripe.Checkout.Session["customer_details"],
): Promise<{ recorded: boolean }> {
  const taxId = customerDetails?.tax_ids?.find((t) => t.value);
  if (!tenantId || !taxId?.value) return { recorded: false };

  const update: Record<string, unknown> = {
    tax_id_type: taxId.type ?? null,
    tax_id_value: clean(taxId.value, 50),
    tax_id_captured_at: new Date().toISOString(),
  };
  // The name Checkout collected on the tax-ID form is the buyer's declared
  // legal entity, which may legitimately differ from the workspace name.
  const businessName = clean(customerDetails?.name, 200);
  if (businessName) update.tax_id_business_name = businessName;

  try {
    const { error } = await supabaseAdmin
      .from("tenants")
      .update(asRow<TablesUpdate<"tenants">>(update))
      .eq("id", tenantId);
    if (error) {
      console.warn("[billing-contact] tenant tax id write failed", error.message);
      return { recorded: false };
    }
  } catch (err) {
    console.warn("[billing-contact] tenant tax id write threw", err);
    return { recorded: false };
  }
  return { recorded: true };
}
