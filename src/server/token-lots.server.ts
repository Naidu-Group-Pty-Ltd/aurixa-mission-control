// Token lot arithmetic — the same rules `recompute_token_balance` implements
// in SQL, expressed here so they can be tested and reused.
//
// Credits are LOTS: each carries an amount and an expiry. Spend consumes them
// soonest-expiry-first — the use-it-or-lose-it order, which is also the order
// that leaves a customer with the most usable balance — and expiry forfeits
// only a lot's UNCONSUMED remainder.
//
// That last point is the whole reason lots exist. Netting the ledger and then
// dropping expired credit rows silently under-counts, because the debits taken
// against an expired credit survive while the credit that funded them does
// not:
//
//     grant  +100 (expired)   skipped
//     topup   +50 (live)      +50
//     debit   -30             -30   ⇒ 20
//
// The honest answer is 50: the 30 was already paid for out of the grant, and
// only the grant's unspent 70 should have lapsed.
//
// Consumption is ordered by expiry rather than strictly chronologically. It is
// a deliberate simplification — it keeps the SQL a single set-based query — and
// can only diverge from a time-ordered replay if a debit predates the credit it
// is attributed to, which `reserve_tokens` makes impossible by refusing to
// spend a balance that does not exist yet.

export type TokenLot = {
  /** Positive credit amount. */
  amount: number;
  /** ISO timestamp, or null for a lot that never lapses. */
  expiresAt: string | null;
  /** ISO timestamp the lot was created — tie-breaker within the same expiry. */
  createdAt?: string | null;
  kind?: string;
  reason?: string | null;
};

export type LotRemainder = TokenLot & {
  /** How much of this lot survives after spend is applied. */
  remaining: number;
  /** True when this lot has already lapsed — its remainder is forfeit. */
  expired: boolean;
};

function timeOf(value: string | null | undefined, fallback: number): number {
  if (!value) return fallback;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : fallback;
}

/**
 * Consumption order: soonest expiry first, then oldest, then a stable
 * tie-break. A lot that never expires sorts last — it can always be spent
 * later, so it should be spent last.
 */
export function orderLots(lots: TokenLot[]): TokenLot[] {
  return [...lots].sort((a, b) => {
    const ax = timeOf(a.expiresAt, Number.MAX_SAFE_INTEGER);
    const bx = timeOf(b.expiresAt, Number.MAX_SAFE_INTEGER);
    if (ax !== bx) return ax - bx;
    const ac = timeOf(a.createdAt, 0);
    const bc = timeOf(b.createdAt, 0);
    if (ac !== bc) return ac - bc;
    return 0;
  });
}

/**
 * Apply total spend across the lots and report what survives.
 *
 * `totalSpent` is every debit ever taken, matching the SQL: expiry is derived
 * from the lots, so an explicit 'expiry' ledger row must NOT also be counted
 * or the same credit is forfeited twice.
 */
export function applySpend(
  lots: TokenLot[],
  totalSpent: number,
  now: Date = new Date(),
): LotRemainder[] {
  const nowMs = now.getTime();
  const spend = Math.max(0, Math.floor(totalSpent));
  let cumulative = 0;

  return orderLots(lots).map((lot) => {
    const amount = Math.max(0, Math.floor(lot.amount));
    cumulative += amount;
    // Fully consumed while the running total is still under total spend;
    // partially at the crossover; untouched after it.
    const remaining = Math.max(0, Math.min(amount, cumulative - spend));
    const expired = lot.expiresAt != null && timeOf(lot.expiresAt, Infinity) <= nowMs;
    return { ...lot, remaining, expired };
  });
}

/** Spendable credit: the surviving remainder of every lot that has not lapsed. */
export function spendableBalance(
  lots: TokenLot[],
  totalSpent: number,
  now: Date = new Date(),
): number {
  return applySpend(lots, totalSpent, now)
    .filter((l) => !l.expired)
    .reduce((sum, l) => sum + l.remaining, 0);
}

/** Credit already forfeited to expiry — the unconsumed part of lapsed lots. */
export function forfeitedBalance(
  lots: TokenLot[],
  totalSpent: number,
  now: Date = new Date(),
): number {
  return applySpend(lots, totalSpent, now)
    .filter((l) => l.expired)
    .reduce((sum, l) => sum + l.remaining, 0);
}

export type ExpirySchedule = {
  /** Live lots with something left, soonest expiry first. */
  upcoming: LotRemainder[];
  /** Credit lapsing within `withinDays`. */
  expiringSoon: number;
  /** When the next credit lapses, or null if nothing is dated. */
  nextExpiryAt: string | null;
};

export const EXPIRY_WARNING_DAYS = 7;

/**
 * What lapses, and when — for the "N credits expire in X days" warning.
 *
 * Derived from the same lot arithmetic as the balance, so the warning can
 * never contradict the number next to it.
 */
export function expirySchedule(
  lots: TokenLot[],
  totalSpent: number,
  opts: { now?: Date; withinDays?: number } = {},
): ExpirySchedule {
  const now = opts.now ?? new Date();
  const withinDays = opts.withinDays ?? EXPIRY_WARNING_DAYS;
  const horizon = now.getTime() + withinDays * 24 * 60 * 60 * 1000;

  const upcoming = applySpend(lots, totalSpent, now)
    .filter((l) => !l.expired && l.remaining > 0)
    .sort((a, b) => {
      const ax = timeOf(a.expiresAt, Number.MAX_SAFE_INTEGER);
      const bx = timeOf(b.expiresAt, Number.MAX_SAFE_INTEGER);
      return ax - bx;
    });

  const dated = upcoming.filter((l) => l.expiresAt != null);
  const expiringSoon = dated
    .filter((l) => timeOf(l.expiresAt, Infinity) <= horizon)
    .reduce((sum, l) => sum + l.remaining, 0);

  return {
    upcoming,
    expiringSoon,
    nextExpiryAt: dated.length > 0 ? (dated[0].expiresAt as string) : null,
  };
}

/** Platform token lifetime. Mirrors `public.token_expiry_days()`. */
export const TOKEN_EXPIRY_DAYS = 30;

/**
 * Expiry for a newly issued credit.
 *
 * `overrideAt` is honoured only for gifts — it is the operator-set date on
 * `grant_tokens`. Plan allowances and top-up packs have no override: they get
 * the platform lifetime, or the pack's own shorter window if it has one.
 */
export function resolveIssueExpiry(
  issuedAt: Date,
  opts: { overrideAt?: Date | null; packDays?: number | null } = {},
): Date {
  if (opts.overrideAt) return opts.overrideAt;
  const days =
    opts.packDays != null && opts.packDays > 0
      ? Math.min(opts.packDays, TOKEN_EXPIRY_DAYS)
      : TOKEN_EXPIRY_DAYS;
  return new Date(issuedAt.getTime() + days * 24 * 60 * 60 * 1000);
}
