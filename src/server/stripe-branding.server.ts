/**
 * Puts the Aurixa brand onto the Stripe account.
 *
 * Stripe renders a lot of customer-facing surface on our behalf — receipts,
 * invoice PDFs, the hosted invoice page, Checkout, Payment Links, the customer
 * portal, and the emails that carry them. All of it is styled from four fields
 * on `account.settings.branding`, and until this runs all four are null, which
 * is why every one of those surfaces currently arrives as an unbranded Stripe
 * default.
 *
 * Split into plan and apply for the same reason as the catalog cutovers: plan
 * reads the live account and touches nothing, so an operator can see exactly
 * which of the four fields will change before anything is written.
 *
 * ── The two things that can legitimately fail here ──────────────────────────
 *
 *  1. **The upload.** Stripe takes the images through the Files API, not as
 *     URLs, so the bytes have to be fetched from the marketing site first.
 *     That deployment is separate from this one; a brand asset that has not
 *     shipped there yet is a 404, and the fix is to deploy the site, not to
 *     retry this.
 *
 *  2. **The account write.** `settings.branding` lives on the Account object,
 *     and Stripe restricts which accounts an API key may write that on. If it
 *     refuses, the uploaded File ids are still valid and are exactly what the
 *     Dashboard's Branding page needs, so they are returned either way and the
 *     card shows them rather than making an operator dig through a stack
 *     trace.
 *
 * Uploaded files are NOT deduplicated. Stripe files are immutable and cost
 * nothing to hold, and reusing an id would mean trusting that the bytes behind
 * it are still the bytes we just built.
 */
import type Stripe from "stripe";
import { getStripe } from "@/server/stripe.server";
import {
  AURIXA_BRAND_ASSETS,
  AURIXA_STRIPE_BRANDING,
  DEFAULT_BRAND_ASSET_ORIGIN,
  STRIPE_IMAGE_LIMITS,
  brandAssetUrl,
  readableInkOn,
  type BrandAssetKind,
  type BrandAssetSpec,
} from "@/lib/brand/aurixa-brand";

/** One field of `settings.branding`, and what it is about to become. */
export type BrandField = {
  field: "icon" | "logo" | "primary_color" | "secondary_color";
  /** What the live account holds. `null` means Stripe has nothing set. */
  current: string | null;
  /** What applying would set. For the two images this is the source URL —
   *  the File id does not exist until upload time. */
  desired: string;
  /** Colours are compared exactly; images always re-upload, so always true. */
  changes: boolean;
  /** Which customer-facing surfaces this field reaches. */
  reaches: string;
};

export type BrandSyncPlan = {
  accountId: string;
  /** Whether the key in use is pointed at live mode. */
  livemode: boolean;
  displayName: string | null;
  fields: BrandField[];
  /** Assets that could not be fetched from the marketing site. */
  warnings: string[];
  /** The ink Stripe will pick for text on the brand colour. */
  primaryInk: string;
};

/** Where the brand PNGs are served from. Overridable for a staging origin. */
function assetOrigin(): string {
  return process.env.AURIXA_BRAND_ASSET_ORIGIN?.trim() || DEFAULT_BRAND_ASSET_ORIGIN;
}

/**
 * `account.settings.branding` as we read it back.
 *
 * Declared structurally rather than as `Stripe.Account.Settings.Branding` so a
 * change to how the SDK nests that namespace cannot break this file — all four
 * fields are stable API, and the images come back as either a File id or an
 * expanded File object depending on the request.
 */
type LiveBranding = {
  icon?: string | { id: string } | null;
  logo?: string | { id: string } | null;
  primary_color?: string | null;
  secondary_color?: string | null;
};

/** The Account the API key belongs to.
 *
 * Stripe's typings insist on an id here; the REST API does not, and an omitted
 * id means "the account this key belongs to" — which is the only account we
 * could be branding. Retrieving by an id we would first have to know is
 * circular, hence the cast. */
function retrieveOwnAccount(stripe: ReturnType<typeof getStripe>) {
  return (stripe.accounts.retrieve as unknown as () => Promise<Stripe.Account>)();
}

/** A File id, whether Stripe returned the id or the expanded object. */
function fileId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : value.id;
}

/** Which surfaces each field reaches, per Stripe's branding documentation. */
const REACHES: Record<BrandField["field"], string> = {
  icon: "Emails, Checkout, customer portal, hosted invoice page, invoice PDFs",
  logo: "Checkout & Payment Links, invoice PDFs",
  primary_color: "Emails, customer portal, hosted invoice page, invoice PDFs",
  secondary_color: "Backgrounds — emails, Checkout, portal, hosted invoice page",
};

/**
 * Reads the account and reports what would change. Writes nothing.
 *
 * The two image fields always report `changes: true`. Stripe stores them as
 * opaque File ids, so the live value cannot be compared against a source PNG;
 * claiming "unchanged" would mean claiming the bytes behind an id we have
 * never read.
 */
export async function planBrandSync(): Promise<BrandSyncPlan> {
  const stripe = getStripe();
  const account = await retrieveOwnAccount(stripe);
  const branding = (account.settings?.branding ?? {}) as LiveBranding;
  const origin = assetOrigin();

  const fields: BrandField[] = [
    {
      field: "icon",
      current: fileId(branding.icon),
      desired: brandAssetUrl(AURIXA_BRAND_ASSETS.icon, origin),
      changes: true,
      reaches: REACHES.icon,
    },
    {
      field: "logo",
      current: fileId(branding.logo),
      desired: brandAssetUrl(AURIXA_BRAND_ASSETS.logo, origin),
      changes: true,
      reaches: REACHES.logo,
    },
    {
      field: "primary_color",
      current: branding.primary_color ?? null,
      desired: AURIXA_STRIPE_BRANDING.primaryColor,
      changes:
        (branding.primary_color ?? "").toUpperCase() !==
        AURIXA_STRIPE_BRANDING.primaryColor.toUpperCase(),
      reaches: REACHES.primary_color,
    },
    {
      field: "secondary_color",
      current: branding.secondary_color ?? null,
      desired: AURIXA_STRIPE_BRANDING.secondaryColor,
      changes:
        (branding.secondary_color ?? "").toUpperCase() !==
        AURIXA_STRIPE_BRANDING.secondaryColor.toUpperCase(),
      reaches: REACHES.secondary_color,
    },
  ];

  // Check the assets are actually reachable before an operator commits to
  // applying. A HEAD is enough and costs nothing; discovering a 404 halfway
  // through apply would leave the account with one of the two marks set.
  const warnings: string[] = [];
  for (const asset of Object.values(AURIXA_BRAND_ASSETS)) {
    const url = brandAssetUrl(asset, origin);
    try {
      const res = await fetch(url, { method: "HEAD" });
      if (!res.ok) {
        warnings.push(`${asset.kind}: ${url} returned ${res.status}. Deploy the marketing site.`);
        continue;
      }
      const type = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (type && !STRIPE_IMAGE_LIMITS.contentTypes.includes(type as "image/png")) {
        warnings.push(`${asset.kind}: served as ${type}; Stripe accepts only PNG or JPEG.`);
      }
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > STRIPE_IMAGE_LIMITS.maxBytes) {
        warnings.push(
          `${asset.kind}: ${Math.round(length / 1024)} KB exceeds Stripe's ${
            STRIPE_IMAGE_LIMITS.maxBytes / 1024
          } KB cap.`,
        );
      }
    } catch (err) {
      warnings.push(
        `${asset.kind}: ${url} unreachable (${err instanceof Error ? err.message : String(err)}).`,
      );
    }
  }

  return {
    accountId: account.id,
    // From the key, not the account id — an account id carries no mode, and a
    // preview that claims "test mode" while pointed at the live account is
    // worse than one that says nothing.
    livemode: (process.env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live"),
    displayName: account.settings?.dashboard?.display_name ?? null,
    fields,
    warnings,
    primaryInk: readableInkOn(AURIXA_STRIPE_BRANDING.primaryColor),
  };
}

/** Fetches an asset and checks it against Stripe's limits before upload. */
async function fetchBrandAsset(
  asset: BrandAssetSpec,
  origin: string,
): Promise<{ bytes: Uint8Array; name: string; type: string }> {
  const url = brandAssetUrl(asset, origin);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${asset.kind}: ${url} returned ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > STRIPE_IMAGE_LIMITS.maxBytes) {
    throw new Error(
      `${asset.kind}: ${Math.round(bytes.byteLength / 1024)} KB exceeds Stripe's cap`,
    );
  }
  // A truncated or HTML-error response would otherwise be uploaded happily and
  // rejected by Stripe with a message that does not name the file.
  const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!isPng && !isJpeg) throw new Error(`${asset.kind}: ${url} is not a PNG or JPEG`);
  return {
    bytes,
    name: asset.path.split("/").pop() ?? `aurixa-${asset.kind}.png`,
    type: isPng ? "image/png" : "image/jpeg",
  };
}

export type BrandApplyResult = {
  ok: boolean;
  accountId: string;
  /** File ids Stripe minted, by mark. Present even when the account write
   *  fails — they are what an operator would paste into the Dashboard. */
  fileIds: Partial<Record<BrandAssetKind, string>>;
  /** True once `settings.branding` on the account actually holds these. */
  accountUpdated: boolean;
  applied: {
    primaryColor: string;
    secondaryColor: string;
  };
  errors: string[];
  notes: string[];
};

/**
 * Uploads both marks and writes all four branding fields onto the account.
 *
 * Upload first, account write second, deliberately: a failed upload leaves the
 * account untouched, whereas writing colours first would leave a half-branded
 * account if the upload then failed.
 */
export async function applyBrandSync(): Promise<BrandApplyResult> {
  const stripe = getStripe();
  const origin = assetOrigin();
  const errors: string[] = [];
  const notes: string[] = [];
  const fileIds: Partial<Record<BrandAssetKind, string>> = {};

  const account = await retrieveOwnAccount(stripe);

  for (const asset of Object.values(AURIXA_BRAND_ASSETS)) {
    try {
      const { bytes, name, type } = await fetchBrandAsset(asset, origin);
      const file = await stripe.files.create({
        purpose: asset.purpose,
        file: { data: bytes, name, type },
      });
      fileIds[asset.kind] = file.id;
      notes.push(
        `${asset.kind}: uploaded ${name} (${Math.round(bytes.byteLength / 1024)} KB) as ${file.id}`,
      );
    } catch (err) {
      errors.push(`${asset.kind}: ${stripeMessage(err)}`);
    }
  }

  const applied = {
    primaryColor: AURIXA_STRIPE_BRANDING.primaryColor,
    secondaryColor: AURIXA_STRIPE_BRANDING.secondaryColor,
  };

  if (errors.length) {
    return {
      ok: false,
      accountId: account.id,
      fileIds,
      accountUpdated: false,
      applied,
      errors,
      notes,
    };
  }

  let accountUpdated = false;
  try {
    const branding: Stripe.AccountUpdateParams.Settings.Branding = {
      primary_color: applied.primaryColor,
      secondary_color: applied.secondaryColor,
      ...(fileIds.icon ? { icon: fileIds.icon } : {}),
      ...(fileIds.logo ? { logo: fileIds.logo } : {}),
    };
    await stripe.accounts.update(account.id, { settings: { branding } });
    accountUpdated = true;
    notes.push("Account branding updated. It applies to new emails, pages and PDFs immediately.");
  } catch (err) {
    // Stripe restricts which accounts a key may write `settings.branding` on.
    // The uploaded file ids are still valid and still what the Dashboard needs,
    // so this is a degraded success, not a wasted run.
    errors.push(
      `account update rejected: ${stripeMessage(err)}. The uploads succeeded — set the four fields on the Branding page instead.`,
    );
  }

  return {
    ok: accountUpdated,
    accountId: account.id,
    fileIds,
    accountUpdated,
    applied,
    errors,
    notes,
  };
}

/** Sanitized, operator-actionable message from a Stripe SDK error. */
function stripeMessage(err: unknown): string {
  const e = err as { raw?: { message?: string }; message?: string } | null;
  return String(e?.raw?.message ?? e?.message ?? "stripe_error").slice(0, 300);
}
