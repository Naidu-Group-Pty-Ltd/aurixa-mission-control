// What a workspace is actually asked, and why it differs per workspace.
//
// A feedback form that asks every customer the same thirty questions gets
// answered by nobody. Asking a Launch workspace to rate Marketing — a module
// only Scale includes — is worse than useless: it produces a score for
// something they have never opened, and it tells them we do not know what
// they bought.
//
// So the module questions are derived from the plan. Everyone is asked about
// the core areas they demonstrably use, plus the priced modules their tier
// actually includes. Nothing else.
//
// Pure and dependency-free, so what gets asked is decided by tests rather than
// by whatever the database returned.
import { MODULES, TIERS, type PricedModule } from "@/lib/pricing/aurixa-catalog";

export type RatingQuestion = {
  /** Stable key stored in module_ratings — a module slug, or a core area. */
  key: string;
  label: string;
  /** One line saying what is being rated, so a score means the same thing to everyone. */
  hint: string;
  group: string;
};

/**
 * The parts of the product every workspace has, whatever they pay.
 *
 * Not in MODULES because MODULES is the priced add-on list — these come with
 * the platform. They are asked first because they are what most people spend
 * most of their time in, and a form that opens with an add-on nobody uses
 * reads as irrelevant.
 */
export const CORE_AREAS: readonly RatingQuestion[] = [
  {
    key: "core.reports",
    label: "Generated reports",
    hint: "Quality and accuracy of the reports you produce",
    group: "The everyday",
  },
  {
    key: "core.clients",
    label: "Client management",
    hint: "Keeping client records, documents and activity in one place",
    group: "The everyday",
  },
  {
    key: "core.dashboard",
    label: "Dashboard & navigation",
    hint: "Finding what you need and seeing where things stand",
    group: "The everyday",
  },
  {
    key: "core.speed",
    label: "Speed & reliability",
    hint: "How quickly it responds, and whether it does so consistently",
    group: "The everyday",
  },
  {
    key: "core.support",
    label: "Support & onboarding",
    hint: "Getting help, and getting started in the first place",
    group: "The everyday",
  },
];

/** A module question, phrased as something a user can actually judge. */
function moduleQuestion(m: PricedModule): RatingQuestion {
  return {
    key: m.slug,
    label: m.name,
    hint: m.note ? m.note.replace(/\.$/, "") : `How well ${m.name} works for your firm`,
    group: m.category,
  };
}

/**
 * The modules this workspace is asked to rate.
 *
 * A known tier is asked about exactly what that tier includes. An unknown
 * plan — Enterprise, a billing-exempt tenant, a workspace whose plan lookup
 * failed — is asked about nothing module-specific rather than being asked
 * about everything: guessing wrong in that direction produces scores for
 * modules the workspace does not have, which quietly poisons the averages.
 * The core areas still apply, so the form is never empty.
 */
export function modulesForPlan(planSlug: string | null | undefined): PricedModule[] {
  if (!planSlug) return [];
  const known = TIERS.some((t) => t.slug === planSlug);
  if (!known) return [];
  return MODULES.filter((m) => !m.comingSoon && m.includedIn.includes(planSlug));
}

export type FeedbackForm = {
  planSlug: string | null;
  planName: string | null;
  questions: RatingQuestion[];
  /** Groups in the order they should be rendered. */
  groups: string[];
};

/**
 * The whole form spec for a workspace.
 *
 * Order is deliberate and stable: the everyday first, then modules grouped as
 * the price list groups them. Stability matters because a rating is only
 * comparable across quarters if the question it answered has not moved.
 */
export function buildFeedbackForm(plan: {
  slug?: string | null;
  name?: string | null;
}): FeedbackForm {
  const slug = plan.slug ?? null;
  const modules = modulesForPlan(slug);
  const questions = [...CORE_AREAS, ...modules.map(moduleQuestion)];

  const groups: string[] = [];
  for (const q of questions) if (!groups.includes(q.group)) groups.push(q.group);

  return { planSlug: slug, planName: plan.name ?? null, questions, groups };
}

/**
 * Discards ratings for questions this workspace was never asked, and anything
 * outside 1–5.
 *
 * The form is public — it is served to a browser, and a browser can post
 * whatever it likes. Storing an unasked module's score would put a number
 * against a product the workspace does not have, which is worse than losing
 * it. Silently dropped rather than rejected: a stray key is not a reason to
 * lose someone's written feedback.
 */
export function sanitiseRatings(raw: unknown, form: FeedbackForm): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const allowed = new Set(form.questions.map((q) => q.key));
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(key)) continue;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 5) continue;
    out[key] = n;
  }
  return out;
}

/** Clamp a whole-number score to a range, or drop it. */
export function scoreOrNull(raw: unknown, min: number, max: number): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

/** Free text, trimmed and bounded. Empty becomes null so the column stays honest. */
export function textOrNull(raw: unknown, max = 4000): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, max) : null;
}
