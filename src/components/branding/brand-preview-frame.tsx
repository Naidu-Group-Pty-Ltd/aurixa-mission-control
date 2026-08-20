// Renders a stylised preview of a brand bundle: logo, palette swatches,
// hero card, button + sample report contact block. Pure presentational —
// takes a merged bundle and renders it. Used by the playground AND the
// override editor for live "what will this look like" feedback.
import { cn } from "@/lib/utils";
import { Mail, Phone, Globe, MapPin } from "lucide-react";

export type PreviewBundle = {
  brand_config: Record<string, string | null | undefined>;
  report_contact: Record<string, string | null | undefined>;
};

export function BrandPreviewFrame({
  bundle,
  variant = "light",
  className,
}: {
  bundle: PreviewBundle;
  variant?: "light" | "dark";
  className?: string;
}) {
  const cfg = bundle.brand_config ?? {};
  const contact = bundle.report_contact ?? {};
  const isDark = variant === "dark";
  const bg = isDark ? cfg.background_color || "#0a0a0a" : cfg.background_color || "#ffffff";
  const fg = isDark ? cfg.foreground_color || "#fafafa" : cfg.foreground_color || "#0a0a0a";
  const primary = cfg.primary_color || "#0066ff";
  const accent = cfg.accent_color || "#ff6b35";
  const logo = isDark ? cfg.logo_dark_url : cfg.logo_light_url;
  const fontFamily = cfg.font_family || "system-ui, sans-serif";

  return (
    <div
      className={cn("rounded-lg border border-border/60 overflow-hidden shadow-sm", className)}
      style={{ background: bg, color: fg, fontFamily }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 border-b"
        style={{ borderColor: `${fg}20` }}
      >
        <div className="flex items-center gap-2">
          {logo ? (
            <img
              src={logo}
              alt={cfg.brand_name ?? "Logo"}
              className="h-7 w-auto max-w-[120px] object-contain"
            />
          ) : (
            <div
              className="h-7 w-7 flex items-center justify-center text-xs font-bold"
              style={{ background: primary, color: "#fff" }}
            >
              {(cfg.brand_name?.[0] ?? "B").toUpperCase()}
            </div>
          )}
          <div className="text-sm font-semibold">{cfg.brand_name || "Brand name"}</div>
        </div>
        {cfg.support_url && (
          <span className="text-[10px] opacity-60 truncate max-w-[140px]">{cfg.support_url}</span>
        )}
      </div>

      {/* Hero */}
      <div className="px-4 py-5 space-y-2">
        <h3 className="text-lg font-semibold leading-tight">
          {cfg.tagline || "Your tagline appears here"}
        </h3>
        <p className="text-xs opacity-70 leading-relaxed">
          This is a sample preview of how your brand renders across reports, emails, and the
          customer dashboard.
        </p>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium"
            style={{ background: primary, color: "#fff" }}
          >
            Primary action
          </button>
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium border"
            style={{ borderColor: accent, color: accent }}
          >
            Secondary
          </button>
        </div>
      </div>

      {/* Swatches */}
      <div className="grid grid-cols-5 gap-1 px-4 pb-3" style={{ borderTop: `1px solid ${fg}10` }}>
        {(
          [
            ["primary_color", "Primary"],
            ["secondary_color", "Secondary"],
            ["accent_color", "Accent"],
            ["background_color", "BG"],
            ["foreground_color", "FG"],
          ] as const
        ).map(([key, label]) => (
          <div key={key} className="space-y-1 pt-2">
            <div
              className="h-6 w-full border"
              style={{
                background: cfg[key] || "#888",
                borderColor: `${fg}20`,
              }}
            />
            <div className="text-[9px] opacity-60 text-center">{label}</div>
          </div>
        ))}
      </div>

      {/* Contact strip */}
      {(contact.contact_name || contact.contact_email || contact.contact_phone) && (
        <div
          className="px-4 py-3 text-[11px] space-y-1"
          style={{
            background: `${fg}05`,
            borderTop: `1px solid ${fg}10`,
          }}
        >
          {contact.contact_name && <div className="font-medium">{contact.contact_name}</div>}
          <div className="flex flex-wrap gap-x-3 gap-y-1 opacity-75">
            {contact.contact_email && (
              <span className="flex items-center gap-1">
                <Mail className="h-3 w-3" /> {contact.contact_email}
              </span>
            )}
            {contact.contact_phone && (
              <span className="flex items-center gap-1">
                <Phone className="h-3 w-3" /> {contact.contact_phone}
              </span>
            )}
            {contact.contact_website && (
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3" /> {contact.contact_website}
              </span>
            )}
            {contact.contact_address && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {contact.contact_address}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
