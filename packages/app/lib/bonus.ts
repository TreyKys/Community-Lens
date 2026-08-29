// Bonus credit expires. The app has to know that.
//
// THE BUG THIS EXISTS TO KILL: bonus_balance expires seven days after it is
// credited (trg_users_bonus_expires, 20260630200000), and every staking RPC
// zeroes expired bonus before checking whether you can afford the stake. But
// nothing the user could see ever read bonus_expires_at — six separate
// surfaces displayed the raw column as spendable money.
//
// So somebody with expired bonus saw "₦5,000" on their dashboard, in the
// navbar, and in their wallet, and got "Insufficient balance" on every single
// attempt to use it. Nothing in the product told them why, and nothing they
// could do would fix it. That is the worst shape a money bug can take: the
// number the user trusts is the one number that is wrong.
//
// Anything that shows a balance, or decides whether a stake is affordable,
// goes through here.

/** What the staking engines will actually let you spend. */
export function spendableBonus(
  bonusBalance: number | null | undefined,
  bonusExpiresAt: string | null | undefined,
  now: Date = new Date(),
): number {
  const bonus = Number(bonusBalance) || 0;
  if (bonus <= 0) return 0;
  // No expiry set means it does not expire. The trigger only stamps a date
  // when bonus is credited, so a legacy balance can genuinely have none, and
  // treating that as "expired" would delete money the engines still honour.
  if (!bonusExpiresAt) return bonus;

  const expires = new Date(bonusExpiresAt);
  // An unparseable date is a data problem, not the user's problem. Matching
  // the SQL, which compares against a real timestamp and skips the branch
  // entirely when the column is NULL.
  if (Number.isNaN(expires.getTime())) return bonus;

  return expires.getTime() <= now.getTime() ? 0 : bonus;
}

/** Cash plus whatever bonus is still live — the number a stake is checked against. */
export function spendableBalance(
  tngnBalance: number | null | undefined,
  bonusBalance: number | null | undefined,
  bonusExpiresAt: string | null | undefined,
  now: Date = new Date(),
): number {
  return (Number(tngnBalance) || 0) + spendableBonus(bonusBalance, bonusExpiresAt, now);
}

/**
 * A short human line about when the bonus goes, or null when there is nothing
 * worth saying.
 *
 * Deliberately silent when there is no bonus, no expiry, or the expiry is far
 * off: a countdown on every screen forever is nagging, and nagging gets
 * ignored, which defeats the point when it finally matters.
 */
export function bonusExpiryNote(
  bonusBalance: number | null | undefined,
  bonusExpiresAt: string | null | undefined,
  now: Date = new Date(),
): string | null {
  const bonus = Number(bonusBalance) || 0;
  if (bonus <= 0 || !bonusExpiresAt) return null;

  const expires = new Date(bonusExpiresAt);
  if (Number.isNaN(expires.getTime())) return null;

  const ms = expires.getTime() - now.getTime();
  if (ms <= 0) return 'Expired';

  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'Expires within the hour';
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.floor(hours / 24);
  // Beyond three days it is not news yet.
  if (days > 3) return null;
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}
