// Build the SQL we run against a clone backend to apply a brand bundle.
// Targets two prime-schema tables:
//   - whitelabel_settings        (jsonb 'settings' column)
//   - global_report_settings     (jsonb 'contact_details' column)
// UPSERT semantics: try update, fall back to insert if no row exists.
import type { BrandConfig, ReportContact } from "./types";

/**
 * Escape a JSON value for safe inlining inside a Postgres SQL string.
 * We use $brand$ dollar-quoting and sanitise the payload to ensure the
 * delimiter cannot appear inside it.
 */
function jsonbLiteral(value: unknown): string {
  const json = JSON.stringify(value).replace(/\$brand\$/g, "");
  return `$brand$${json}$brand$::jsonb`;
}

/**
 * Translate the bundle's contact block onto the keys the prime actually
 * reads from `contact_details` (`snapshot.pure.ts` → `name`, `abn`, `email`,
 * `phone`, `address`, `website`, plus the legacy `company_name`).
 *
 * The `contact_*` names this module historically cascaded are keys the prime
 * never consumed — a cascaded email or phone silently never reached a single
 * generated document. Both shapes are written: the prime's keys so documents
 * pick the values up, and the original `contact_*` keys so nothing that
 * learned to read them breaks.
 */
export function primeContactPayload(contact: ReportContact): Record<string, unknown> {
  const text = (v: unknown) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s || undefined;
  };
  const mapped: Record<string, unknown> = {
    ...contact,
    name: text(contact.legal_name) ?? text(contact.contact_name),
    company_name: text(contact.legal_name) ?? text(contact.contact_name),
    abn: text(contact.abn),
    licence_number: text(contact.licence_number),
    email: text(contact.contact_email),
    phone: text(contact.contact_phone),
    address: text(contact.contact_address),
    website: text(contact.contact_website),
  };
  for (const [key, value] of Object.entries(mapped)) {
    if (value === undefined || value === null || value === "") delete mapped[key];
  }
  return mapped;
}

export function buildApplySql(args: {
  brand_config: BrandConfig;
  report_contact: ReportContact;
  config_hash: string;
}): string {
  const { brand_config, report_contact, config_hash } = args;

  const wlPayload = jsonbLiteral({ ...brand_config, _aurixa_hash: config_hash });
  const rcPayload = jsonbLiteral(primeContactPayload(report_contact));

  return `
-- Aurixa branding cascade — hash:${config_hash}
DO $$
DECLARE
  _wl_exists boolean;
  _rs_exists boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='whitelabel_settings') THEN
    SELECT EXISTS(SELECT 1 FROM public.whitelabel_settings) INTO _wl_exists;
    IF _wl_exists THEN
      UPDATE public.whitelabel_settings
      SET settings = COALESCE(settings, '{}'::jsonb) || ${wlPayload},
          updated_at = now()
      WHERE id = (SELECT id FROM public.whitelabel_settings ORDER BY updated_at DESC NULLS LAST LIMIT 1);
    ELSE
      INSERT INTO public.whitelabel_settings (settings) VALUES (${wlPayload});
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_schema='public' AND table_name='global_report_settings') THEN
    SELECT EXISTS(SELECT 1 FROM public.global_report_settings) INTO _rs_exists;
    IF _rs_exists THEN
      UPDATE public.global_report_settings
      SET contact_details = COALESCE(contact_details, '{}'::jsonb) || ${rcPayload},
          updated_at = now()
      WHERE id = (SELECT id FROM public.global_report_settings ORDER BY updated_at DESC NULLS LAST LIMIT 1);
    ELSE
      INSERT INTO public.global_report_settings (contact_details) VALUES (${rcPayload});
    END IF;
  END IF;
END $$;
`;
}
