'use client';

import { useEffect, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Loader2, User as UserIcon, Wallet, TrendingUp, ArrowDownToLine, ArrowUpFromLine, Users as UsersIcon, Award, Activity, Bell } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  userId: string | null;
  onClose: () => void;
}

// Full forensic view of one user — slides in from the right when admin
// clicks "View" on a row in the Users panel. Pulls /api/admin/users/[id]
// once on open, then refreshes every 30s while open so the admin sees
// live bet placements / deposits / etc.
export function UserDetailDrawer({ userId, onClose }: Props) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!userId) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setData(d);
      } catch { /* non-critical */ }
      finally { if (alive) setIsLoading(false); }
    };
    setIsLoading(true);
    load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [userId]);

  const f = (n: number | null | undefined) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;
  const dt = (s: string | null | undefined) => s
    ? new Date(s).toLocaleString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <Sheet open={!!userId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl md:max-w-4xl p-0 overflow-y-auto">
        {isLoading && !data && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <>
            <SheetHeader className="px-6 pt-6 pb-4 border-b">
              <SheetTitle className="flex items-center gap-2 flex-wrap">
                <UserIcon className="w-4 h-4" />
                <span className="truncate">{data.user.email || data.user.username || data.user.id.slice(0, 12)}</span>
                {data.user.is_vip && (
                  <Badge className="text-[10px] h-5 bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30">VIP</Badge>
                )}
                {data.ownerAccount && (
                  <Badge className="text-[10px] h-5 bg-emerald-500/20 text-emerald-400 border-emerald-500/30">OWNER</Badge>
                )}
                {data.user.is_custodial && (
                  <Badge variant="outline" className="text-[10px] h-5">CUSTODIAL</Badge>
                )}
              </SheetTitle>
              <SheetDescription className="text-xs font-mono break-all">
                {data.user.id}
              </SheetDescription>
            </SheetHeader>

            <Tabs defaultValue="overview" className="w-full">
              <TabsList className="w-full justify-start rounded-none border-b h-auto p-0 bg-transparent overflow-x-auto no-scrollbar">
                {[
                  { value: 'overview',     label: 'Overview',     icon: UserIcon },
                  { value: 'bets',         label: `Bets (${data.bets.summary.total})`, icon: TrendingUp },
                  { value: 'deposits',     label: `Deposits (${data.deposits.summary.count})`, icon: ArrowDownToLine },
                  { value: 'withdrawals',  label: `Withdrawals (${data.withdrawals.summary.count})`, icon: ArrowUpFromLine },
                  { value: 'referrals',    label: `Referrals (${data.referrals.refereesCount})`, icon: UsersIcon },
                  { value: 'points',       label: 'Points',       icon: Award },
                  { value: 'activity',     label: 'Activity',     icon: Activity },
                  { value: 'notifications', label: `Inbox (${data.notifications.length})`, icon: Bell },
                ].map(t => (
                  <TabsTrigger
                    key={t.value}
                    value={t.value}
                    className="rounded-none border-b-2 border-transparent data-[state=active]:border-emerald-500 data-[state=active]:bg-transparent text-xs px-3 py-2.5 gap-1.5 whitespace-nowrap"
                  >
                    <t.icon className="w-3.5 h-3.5" />
                    {t.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              {/* OVERVIEW ───────────────────────────────────────────── */}
              <TabsContent value="overview" className="p-6 space-y-5 mt-0">
                <Section title="Wallet">
                  <Stat label="tNGN balance" value={f(data.user.tngn_balance)} color="text-emerald-400" />
                  <Stat label="Bonus balance" value={f(data.user.bonus_balance)} color="text-amber-400" />
                  <Stat label="Points" value={(data.user.points || 0).toLocaleString()} color="text-violet-300" />
                </Section>

                <Section title="Bet performance">
                  <Stat label="Total bets" value={data.bets.summary.total} />
                  <Stat label="Won / Lost" value={`${data.bets.summary.won} / ${data.bets.summary.lost}`} />
                  <Stat label="Win rate" value={`${Math.round((data.bets.summary.winRate || 0) * 100)}%`} color="text-emerald-400" />
                  <Stat label="Total staked" value={f(data.bets.summary.totalStaked)} />
                  <Stat label="Total won" value={f(data.bets.summary.totalWon)} color="text-emerald-400" />
                  <Stat label="Net result" value={f(data.bets.summary.netResult)} color={data.bets.summary.netResult >= 0 ? 'text-emerald-400' : 'text-red-400'} />
                </Section>

                <Section title="Money in / out">
                  <Stat label="Deposits (₦)" value={f(data.deposits.summary.totalNaira)} />
                  <Stat label="tNGN credited" value={f(data.deposits.summary.totalCredited)} />
                  <Stat label="Last deposit" value={data.deposits.summary.lastDepositAt ? dt(data.deposits.summary.lastDepositAt) : '—'} />
                  <Stat label="Withdrawals processed" value={f(data.withdrawals.summary.totalProcessed)} />
                  <Stat label="Withdrawals pending" value={f(data.withdrawals.summary.totalPending)} color="text-amber-400" />
                </Section>

                <Section title="Profile">
                  <Stat label="Joined" value={dt(data.user.created_at)} />
                  <Stat label="Terms accepted" value={data.user.tos_accepted_at ? `${dt(data.user.tos_accepted_at)} (v${data.user.tos_version})` : '—'} />
                  <Stat label="Welcome email" value={data.user.welcome_email_sent_at ? dt(data.user.welcome_email_sent_at) : 'Not sent'} />
                  <Stat label="Phone" value={data.user.phone || '—'} />
                  <Stat label="Wallet address" value={data.user.wallet_address ? `${data.user.wallet_address.slice(0, 10)}…${data.user.wallet_address.slice(-6)}` : '—'} className="font-mono text-[10px]" />
                </Section>

                {data.referrer && (
                  <Section title="Referred by">
                    <Stat label="Email" value={data.referrer.email || data.referrer.id?.slice(0, 12)} />
                    <Stat label="Was VIP code?" value={data.user.referred_by_is_vip ? 'Yes' : 'No'} />
                  </Section>
                )}

                {data.welcomeMatch && (
                  <Section title="Welcome Match">
                    <Stat label="Granted at" value={dt(data.welcomeMatch.granted_at)} />
                    <Stat label="Deposit that triggered" value={f(data.welcomeMatch.deposit_amount)} />
                    <Stat label="Credit granted" value={f(data.welcomeMatch.credit_granted)} color="text-emerald-400" />
                  </Section>
                )}

                {data.user.is_vip && (
                  <Section title="VIP earnings">
                    <Stat label="Total earned (rake share)" value={f(data.vipEarnings.summary.totalEarned)} color="text-emerald-400" />
                    <Stat label="Bets paid from" value={data.vipEarnings.summary.count} />
                  </Section>
                )}
              </TabsContent>

              {/* BETS ───────────────────────────────────────────────── */}
              <TabsContent value="bets" className="p-6 mt-0">
                <RowList rows={data.bets.recent} empty="No bets placed yet.">
                  {(b) => (
                    <>
                      <div className="flex items-center gap-2 mb-1 min-w-0">
                        <StatusBadge status={b.status} />
                        <span className="text-[10px] text-muted-foreground">#{b.market_id}</span>
                        <span className="text-sm truncate flex-1">
                          {b.market_question || `Market ${b.market_id}`}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
                        <span>Pick: <span className="text-foreground">{b.outcome_label || `option ${b.outcome_index}`}</span></span>
                        <span>Stake: <span className="text-foreground">{f(b.stake_tngn)}</span></span>
                        {b.status === 'won' && <span className="text-emerald-400">Won: +{f(b.payout_tngn)}</span>}
                        <span className="ml-auto">{dt(b.placed_at)}</span>
                      </div>
                    </>
                  )}
                </RowList>
              </TabsContent>

              {/* DEPOSITS ───────────────────────────────────────────── */}
              <TabsContent value="deposits" className="p-6 mt-0">
                <RowList rows={data.deposits.recent} empty="No deposits yet.">
                  {(d) => (
                    <>
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={d.status} />
                        <span className="text-sm">{f(d.amount_ngn)}</span>
                        <span className="text-[11px] text-muted-foreground">→ {f(d.tngn_credited)} tNGN</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{dt(d.created_at)}</span>
                      </div>
                      <div className="text-[10px] text-muted-foreground font-mono break-all">
                        {d.transaction_ref}
                      </div>
                    </>
                  )}
                </RowList>
              </TabsContent>

              {/* WITHDRAWALS ────────────────────────────────────────── */}
              <TabsContent value="withdrawals" className="p-6 mt-0">
                <RowList rows={data.withdrawals.recent} empty="No withdrawal requests yet.">
                  {(w) => (
                    <>
                      <div className="flex items-center gap-2 mb-1">
                        <StatusBadge status={w.status} />
                        <span className="text-sm font-medium">{f(w.amount_tngn)}</span>
                        <span className="ml-auto text-[11px] text-muted-foreground">{dt(w.created_at)}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {(w.bank_name || w.account_bank || '—')} · {(w.account_number || '—')} · {(w.account_name || '—')}
                      </div>
                      {w.admin_note && <div className="text-[10px] text-amber-300/70 mt-0.5">Admin: {w.admin_note}</div>}
                    </>
                  )}
                </RowList>
              </TabsContent>

              {/* REFERRALS ───────────────────────────────────────────── */}
              <TabsContent value="referrals" className="p-6 mt-0 space-y-5">
                <Section title="Codes owned">
                  {data.referrals.codes.length === 0 ? (
                    <p className="text-xs text-muted-foreground col-span-full">No codes owned (will get one auto-generated on first need).</p>
                  ) : (
                    data.referrals.codes.map((c: any) => (
                      <div key={c.code} className="col-span-full bg-card/40 rounded-md p-3 border border-border/40">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono font-semibold">{c.code}</span>
                          {c.is_vip_code && <Badge className="text-[10px] h-5 bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30">VIP</Badge>}
                          {!c.is_active && <Badge variant="outline" className="text-[10px] h-5">INACTIVE</Badge>}
                        </div>
                        <div className="flex items-center gap-4 text-[11px] text-muted-foreground mt-1.5 tabular-nums">
                          <span>{c.uses_count} use{c.uses_count === 1 ? '' : 's'}</span>
                          {c.is_vip_code && <span>{Math.round(Number(c.rake_share_pct) || 0)}% rake</span>}
                          {Number(c.signup_bonus_tngn) > 0 && <span>{f(c.signup_bonus_tngn)} signup bonus</span>}
                        </div>
                      </div>
                    ))
                  )}
                </Section>

                <Section title={`People they referred (${data.referrals.refereesCount})`}>
                  {data.referrals.referees.length === 0 ? (
                    <p className="text-xs text-muted-foreground col-span-full">Hasn&apos;t referred anyone yet.</p>
                  ) : (
                    data.referrals.referees.map((r: any) => (
                      <div key={r.id} className="col-span-full flex items-center justify-between text-xs bg-card/40 rounded-md px-3 py-2 border border-border/40">
                        <span className="truncate">{r.email || r.username || r.id.slice(0, 12)}</span>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span>{f(r.tngn_balance)}</span>
                          <span>{dt(r.created_at)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </Section>
              </TabsContent>

              {/* POINTS ─────────────────────────────────────────────── */}
              <TabsContent value="points" className="p-6 mt-0 space-y-5">
                <Section title="Breakdown by reason">
                  {Object.keys(data.points.breakdown).length === 0 ? (
                    <p className="text-xs text-muted-foreground col-span-full">No points earned yet.</p>
                  ) : (
                    Object.entries(data.points.breakdown).map(([reason, points]) => (
                      <Stat key={reason} label={String(reason).replace(/_/g, ' ')} value={Number(points).toLocaleString()} />
                    ))
                  )}
                </Section>

                <Section title="Recent point events">
                  {data.points.recent.length === 0 ? (
                    <p className="text-xs text-muted-foreground col-span-full">No history.</p>
                  ) : (
                    data.points.recent.map((p: any, i: number) => (
                      <div key={i} className="col-span-full flex items-center justify-between text-xs bg-card/40 rounded-md px-3 py-1.5 border border-border/40">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="text-[10px] h-5">{String(p.reason).replace(/_/g, ' ')}</Badge>
                          {p.related_user_email && <span className="truncate text-muted-foreground">from {p.related_user_email}</span>}
                        </div>
                        <div className="flex items-center gap-3 text-muted-foreground">
                          <span className={cn('font-semibold tabular-nums', Number(p.points) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {Number(p.points) >= 0 ? '+' : ''}{Number(p.points).toLocaleString()}
                          </span>
                          <span>{dt(p.created_at)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </Section>
              </TabsContent>

              {/* ACTIVITY (treasury_log) ────────────────────────────── */}
              <TabsContent value="activity" className="p-6 mt-0">
                <Section title="Treasury ledger — every money event for this user">
                  {data.treasuryActivity.length === 0 ? (
                    <p className="text-xs text-muted-foreground col-span-full">No ledger activity.</p>
                  ) : (
                    data.treasuryActivity.map((a: any, i: number) => (
                      <div key={i} className="col-span-full flex items-center justify-between text-xs bg-card/40 rounded-md px-3 py-1.5 border border-border/40">
                        <div className="flex items-center gap-2 min-w-0">
                          <Badge variant="outline" className="text-[10px] h-5">{a.type}</Badge>
                        </div>
                        <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
                          <span className={cn('font-semibold', Number(a.amount_tngn) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {Number(a.amount_tngn) >= 0 ? '+' : ''}{f(a.amount_tngn)}
                          </span>
                          <span>{dt(a.created_at)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </Section>
              </TabsContent>

              {/* NOTIFICATIONS ──────────────────────────────────────── */}
              <TabsContent value="notifications" className="p-6 mt-0">
                <RowList rows={data.notifications} empty="Inbox empty.">
                  {(n) => (
                    <>
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-[10px] h-5">{n.type}</Badge>
                        {!n.read_at && <Badge className="text-[10px] h-5 bg-blue-500/20 text-blue-300 border-blue-500/30">UNREAD</Badge>}
                        <span className="ml-auto text-[11px] text-muted-foreground">{dt(n.created_at)}</span>
                      </div>
                      <div className="text-xs">{n.message}</div>
                    </>
                  )}
                </RowList>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Inline tiny helpers (kept local; they leak too much sheet-only style
//    to live anywhere else) ──────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">{title}</h4>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

function Stat({ label, value, color, className }: { label: string; value: string | number; color?: string; className?: string }) {
  return (
    <div className="bg-card/40 rounded-md p-2.5 border border-border/40">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums truncate', color, className)}>{value}</p>
    </div>
  );
}

// Generic on T but we accept any[] in practice — admin data shapes are
// untyped JSON from the API and writing concrete types for each section
// would be churn without payoff.
function RowList({ rows, empty, children }: { rows: any[]; empty: string; children: (r: any) => React.ReactNode }) {
  if (!rows || rows.length === 0) {
    return <p className="text-xs text-muted-foreground">{empty}</p>;
  }
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="bg-card/40 rounded-md p-3 border border-border/40">{children(r)}</div>
      ))}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'won' || status === 'completed' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    status === 'lost' || status === 'rejected' || status === 'failed' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
    status === 'refunded' ? 'bg-muted text-muted-foreground border-muted' :
    status === 'pending_paystack' || status === 'pending_admin_approval' || status === 'crediting' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
    'bg-blue-500/20 text-blue-400 border-blue-500/30';
  return (
    <Badge className={cn('text-[10px] h-5', tone)}>
      {String(status || 'unknown').toUpperCase()}
    </Badge>
  );
}
