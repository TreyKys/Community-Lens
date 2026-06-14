'use client';

import { useEffect, useState } from 'react';
import { pollWhileVisible } from '@/lib/pollWhileVisible';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Loader2, BarChart3, Users as UsersIcon, Activity, Shield, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';

interface Props {
  marketId: number | null;
  onClose: () => void;
  onJumpToUser?: (userId: string) => void;
}

const OUTCOME_COLORS = ['#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#a855f7', '#ec4899'];

// Full forensic view of one market. Shows the distribution chart
// (preserved across all market lifecycle states — open, locked,
// resolved, voided), the bet ledger with bettor emails, and the
// markets-table row in its entirety. Triggered from any "View"
// button on a market row in the admin panel.
export function MarketDetailDrawer({ marketId, onClose, onJumpToUser }: Props) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (marketId === null) { setData(null); return; }
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/admin/markets/${marketId}`, { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setData(d);
      } catch { /* non-critical */ }
      finally { if (alive) setIsLoading(false); }
    };
    setIsLoading(true);
    // 60s + visibility-gated. Drawer aggregation pulls bets/distribution/
    // timeline — re-running it every 30s on a backgrounded tab is the
    // exact pattern that depleted the Nano IO budget.
    const cleanup = pollWhileVisible(load, 60_000);
    return () => { alive = false; cleanup(); };
  }, [marketId]);

  const f = (n: number | null | undefined) => `₦${Math.round(Number(n) || 0).toLocaleString()}`;
  const dt = (s: string | null | undefined) => s
    ? new Date(s).toLocaleString('en-NG', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

  return (
    <Sheet open={marketId !== null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-3xl md:max-w-5xl p-0 overflow-y-auto">
        {isLoading && !data && (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {data && (
          <>
            <SheetHeader className="px-6 pt-6 pb-4 border-b">
              <SheetTitle className="flex items-center gap-2 flex-wrap">
                <span className="text-[10px] text-muted-foreground tabular-nums font-mono">#{data.market.id}</span>
                <StatusBadge status={data.market.status} />
                {data.market.category && <Badge variant="outline" className="text-[10px] h-5">{data.market.category}</Badge>}
                {data.parent && (
                  <Badge variant="outline" className="text-[10px] h-5 gap-1">
                    <GitBranch className="w-2.5 h-2.5" /> sub of #{data.parent.id}
                  </Badge>
                )}
              </SheetTitle>
              <SheetDescription className="text-sm text-foreground/90 font-medium leading-relaxed mt-1">
                {data.market.question}
              </SheetDescription>
              {data.market.resolved_outcome_label && (
                <div className="mt-2 inline-flex items-center gap-2 px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 self-start">
                  <span className="text-[10px] uppercase tracking-wider text-emerald-300">Winner</span>
                  <span className="text-sm font-semibold text-emerald-200">{data.market.resolved_outcome_label}</span>
                </div>
              )}
            </SheetHeader>

            <Tabs defaultValue="distribution" className="w-full">
              <TabsList className="w-full justify-start rounded-none border-b h-auto p-0 bg-transparent overflow-x-auto no-scrollbar">
                {[
                  { value: 'distribution', label: 'Distribution', icon: BarChart3 },
                  { value: 'bets',         label: `Bets (${data.summary.total_bets})`, icon: UsersIcon },
                  { value: 'meta',         label: 'Market info', icon: Activity },
                  { value: 'merkle',       label: 'On-chain', icon: Shield },
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

              {/* DISTRIBUTION ─────────────────────────────────────────── */}
              <TabsContent value="distribution" className="p-6 mt-0 space-y-5">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <Stat label="Total bets" value={data.summary.total_bets} />
                  <Stat label="Unique bettors" value={data.summary.unique_bettors} />
                  <Stat label="Total staked (gross)" value={f(data.summary.total_staked)} />
                  <Stat label="Net pool" value={f(data.summary.total_net_staked)} color="text-emerald-400" />
                  <Stat label="Active" value={data.summary.bets_active} />
                  <Stat label="Won" value={data.summary.bets_won} color="text-emerald-400" />
                  <Stat label="Lost" value={data.summary.bets_lost} color="text-red-400" />
                  <Stat label="Refunded" value={data.summary.bets_refunded} color="text-muted-foreground" />
                </div>

                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">Per-outcome share</h4>
                  <div className="space-y-2.5">
                    {data.distribution.map((d: any, i: number) => (
                      <div key={d.option}>
                        <div className="flex items-center justify-between text-xs mb-1.5">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-2.5 h-2.5 rounded-full" style={{ background: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }} />
                            <span className={cn('font-medium', d.is_winning && 'text-emerald-300')}>{d.option}</span>
                            {d.is_winning && <Badge className="text-[9px] h-4 bg-emerald-500/20 text-emerald-300 border-emerald-500/30">WINNER</Badge>}
                          </div>
                          <div className="flex items-center gap-3 text-muted-foreground tabular-nums">
                            <span>{d.bet_count} bet{d.bet_count === 1 ? '' : 's'}</span>
                            <span>{f(d.amount)}</span>
                            <span className="font-bold text-foreground w-10 text-right">{d.percentage}%</span>
                          </div>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all duration-700"
                            style={{ width: `${d.percentage}%`, background: OUTCOME_COLORS[i % OUTCOME_COLORS.length] }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {data.timeline && data.timeline.length > 1 && (
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-3">Cumulative pool over time</h4>
                    <div className="h-56 bg-card/40 rounded-md border border-border/40 p-3">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={data.timeline}>
                          <defs>
                            {data.market.options.map((opt: string, i: number) => (
                              <linearGradient key={opt} id={`g-${i}`} x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor={OUTCOME_COLORS[i % OUTCOME_COLORS.length]} stopOpacity={0.45} />
                                <stop offset="100%" stopColor={OUTCOME_COLORS[i % OUTCOME_COLORS.length]} stopOpacity={0.05} />
                              </linearGradient>
                            ))}
                          </defs>
                          <CartesianGrid strokeOpacity={0.07} />
                          <XAxis
                            dataKey="time"
                            stroke="#94a3b8"
                            fontSize={10}
                            tickFormatter={(v) => new Date(v).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit' })}
                          />
                          <YAxis stroke="#94a3b8" fontSize={10} tickFormatter={(v) => `₦${(v / 1000).toFixed(0)}k`} />
                          <Tooltip
                            contentStyle={{ background: '#0B1411', border: '1px solid rgba(16,185,129,0.3)', borderRadius: 8, fontSize: 12 }}
                            labelFormatter={(v) => dt(v as string)}
                            formatter={(v: any, name: any) => [f(Number(v)), name as string]}
                          />
                          {data.market.options.map((opt: string, i: number) => (
                            <Area
                              key={opt}
                              type="monotone"
                              dataKey={opt}
                              stackId="1"
                              stroke={OUTCOME_COLORS[i % OUTCOME_COLORS.length]}
                              fill={`url(#g-${i})`}
                              strokeWidth={2}
                            />
                          ))}
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </TabsContent>

              {/* BETS ───────────────────────────────────────────────── */}
              <TabsContent value="bets" className="p-6 mt-0">
                {data.bets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No bets placed on this market.</p>
                ) : (
                  <div className="space-y-1.5">
                    {data.bets.slice().reverse().map((b: any) => (
                      <div key={b.id} className="bg-card/40 rounded-md p-3 border border-border/40">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <StatusBadge status={b.status} />
                          {b.bettor_is_vip && <Badge className="text-[10px] h-5 bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30">VIP</Badge>}
                          <button
                            type="button"
                            onClick={() => onJumpToUser?.(b.user_id)}
                            className={cn('text-sm truncate text-left', onJumpToUser && 'hover:text-emerald-300 underline-offset-2 hover:underline')}
                          >
                            {b.bettor_email || b.bettor_username || b.user_id.slice(0, 12)}
                          </button>
                          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{dt(b.placed_at)}</span>
                        </div>
                        <div className="flex items-center gap-4 text-[11px] text-muted-foreground tabular-nums">
                          <span>Pick: <span className="text-foreground">{b.outcome_label || `option ${b.outcome_index}`}</span></span>
                          <span>Stake: <span className="text-foreground">{f(b.stake_tngn)}</span></span>
                          <span>Net: {f(b.net_stake_tngn)}</span>
                          {b.status === 'won' && <span className="text-emerald-400 ml-auto">Won: +{f(b.payout_tngn)}</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              {/* META ───────────────────────────────────────────────── */}
              <TabsContent value="meta" className="p-6 mt-0 space-y-5">
                <Section title="Lifecycle">
                  <Stat label="Created" value={dt(data.market.created_at)} />
                  <Stat label="Closes" value={dt(data.market.closes_at)} />
                  <Stat label="Locked" value={dt(data.market.locked_at)} />
                  <Stat label="Resolved" value={dt(data.market.resolved_at)} />
                  <Stat label="Resolution" value={data.market.resolved_outcome_label || '—'} color={data.market.resolved_outcome_label ? 'text-emerald-400' : undefined} />
                  <Stat label="Total pool (stored)" value={f(data.market.total_pool)} />
                </Section>
                {(data.market.sport || data.market.home_team || data.market.away_team || data.market.league_code) && (
                  <Section title="Sport / fixture">
                    <Stat label="Sport" value={data.market.sport || '—'} />
                    <Stat label="League" value={data.market.league_code || '—'} />
                    <Stat label="Home" value={data.market.home_team || '—'} />
                    <Stat label="Away" value={data.market.away_team || '—'} />
                    <Stat label="Fixture ID" value={data.market.fixture_id || '—'} />
                  </Section>
                )}
                {data.children.length > 0 && (
                  <Section title={`Sub-markets (${data.children.length})`}>
                    {data.children.map((c: any) => (
                      <div key={c.id} className="col-span-full flex items-center justify-between text-xs bg-card/40 rounded-md px-3 py-2 border border-border/40">
                        <span className="truncate">
                          <span className="text-[10px] text-muted-foreground mr-2">#{c.id}</span>
                          {c.question}
                        </span>
                        <div className="flex items-center gap-2">
                          <StatusBadge status={c.status} />
                          <span className="text-muted-foreground tabular-nums">{f(c.total_pool)}</span>
                        </div>
                      </div>
                    ))}
                  </Section>
                )}
                {data.market.description && (
                  <div>
                    <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Resolution criteria</h4>
                    <p className="text-xs text-foreground/80 whitespace-pre-wrap leading-relaxed">{data.market.description}</p>
                  </div>
                )}
              </TabsContent>

              {/* MERKLE ─────────────────────────────────────────────── */}
              <TabsContent value="merkle" className="p-6 mt-0">
                {data.merkle.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No on-chain commits — market hasn&apos;t been locked yet, or merkle commits were cleared.</p>
                ) : (
                  <div className="space-y-2">
                    {data.merkle.map((m: any, i: number) => (
                      <div key={i} className="bg-card/40 rounded-md p-3 border border-border/40 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Committed</div>
                        <div className="text-xs">{dt(m.committed_at)}</div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2">Merkle root</div>
                        <div className="text-[11px] font-mono break-all">{m.root_hash}</div>
                        {m.tx_hash && (
                          <>
                            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2">Polygon tx</div>
                            <a
                              href={`https://amoy.polygonscan.com/tx/${m.tx_hash}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-[11px] font-mono break-all text-emerald-300 hover:underline"
                            >
                              {m.tx_hash}
                            </a>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">{title}</h4>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">{children}</div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-card/40 rounded-md p-2.5 border border-border/40">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('text-sm font-semibold tabular-nums truncate', color)}>{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'open' || status === 'won' || status === 'completed' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
    status === 'locked' ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' :
    status === 'resolved' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
    status === 'voided' || status === 'refunded' ? 'bg-muted text-muted-foreground border-muted' :
    status === 'lost' ? 'bg-red-500/20 text-red-400 border-red-500/30' :
    'bg-muted text-muted-foreground border-muted';
  return (
    <Badge className={cn('text-[10px] h-5', tone)}>{String(status || 'unknown').toUpperCase()}</Badge>
  );
}
