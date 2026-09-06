'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DataTable, Column } from '@/components/admin/DataTable';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, ShieldAlert, Lock, Unlock, CheckCircle2, Users, Coins, Activity, Sparkles, Upload, Trash2, Send, ExternalLink, Gift, Eye, Flame, Pencil, Plus, Ban, Search, AlertTriangle, XCircle, Copy, CalendarClock } from 'lucide-react';
import { UserDetailDrawer } from '@/components/admin/UserDetailDrawer';
import { MarketDetailDrawer } from '@/components/admin/MarketDetailDrawer';
import { MarketEditDialog } from '@/components/admin/MarketEditDialog';
import { cn } from '@/lib/utils';
import { findBankByCode } from '@/lib/banks';
import { pollWhileVisible } from '@/lib/pollWhileVisible';
import { calculateLockedOdds } from '@/lib/lockedOdds';
import { spendableBonus, bonusExpiryNote } from '@/lib/bonus';
import { groupedLockedOddsHubOptions, getLockedOddsHubOption } from '@/lib/lockedOddsHubOptions';
import Link from 'next/link';

// Admin auth is now cookie-based: POST /api/admin/auth sets an httpOnly cookie
// after server-side validation. The secret never touches the client bundle.
function adminHeaders() {
  return { 'Content-Type': 'application/json' };
}

// NOTE: there is deliberately no cronHeaders() helper any more. It used to
// attach NEXT_PUBLIC_CRON_SECRET to admin-triggered lock/resolve/heartbeat
// calls — but NEXT_PUBLIC_* is embedded in the client bundle, so that
// exposed the cron secret to every visitor. Since /api/markets/lock,
// /api/markets/resolve, and /api/admin/heartbeat all accept the admin
// cookie (isAdminRequest), the panel now authenticates with the cookie
// alone (sent automatically on same-origin fetches). The real CRON_SECRET
// stays server-side only, injected by the GitHub Actions workflows.

// ── Treasury Overview ────────────────────────────────────────────────────
function StatCard({ label, value, sub, icon: Icon, color }: any) {
  return (
    <Card className="bg-card/60 border-emerald-500/15">
      <CardContent className="p-3.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">{label}</span>
          {Icon && <Icon className={cn('w-3.5 h-3.5', color)} />}
        </div>
        <div className="text-xl md:text-2xl font-bold tabular-nums">{value}</div>
        {sub && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function TreasuryPanel() {
  const [stats, setStats] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [heartbeat, setHeartbeat] = useState<{ daysSince: number | null; lastFiredAt: Date | null }>({ daysSince: null, lastFiredAt: null });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [analyticsRes, heartbeatData] = await Promise.all([
        fetch('/api/admin/analytics', { credentials: 'include' }).then(r => r.json()),
        supabase.from('heartbeat_log').select('fired_at').order('fired_at', { ascending: false }).limit(1).then(r => r.data?.[0] || null),
      ]);
      if (!alive) return;
      setStats(analyticsRes);

      const last = heartbeatData?.fired_at ? new Date(heartbeatData.fired_at) : null;
      const days = last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null;
      setHeartbeat({ daysSince: days, lastFiredAt: last });
      setIsLoading(false);
    };
    // 90s + visibility-gated. Analytics is a 2-fetch panel; admins
    // routinely leave it open in a background tab, which was eating
    // Nano IO. Refreshes immediately on tab refocus.
    const cleanup = pollWhileVisible(load, 90_000);
    return () => { alive = false; cleanup(); };
  }, []);

  if (isLoading || !stats) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[...Array(8)].map((_, i) => <div key={i} className="h-20 rounded-xl shimmer" />)}
        </div>
        <div className="h-20 rounded-xl shimmer" />
      </div>
    );
  }

  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;
  const t = stats.treasury, u = stats.users, m = stats.markets, b = stats.bets, r = stats.referrals;

  return (
    <div className="space-y-5">
      {/* ── Vig revenue ─────────────────────────────────────────────────
          The headline metric: what the book has actually netted from
          price-making. Sum of every house-revenue line in treasury_log
          (entry rake, pool rake, locked-odds P&L, multiplier P&L, boost
          ticket sales). Signed — if users beat the book worse than the
          entry rake on a market, that day's vig dips. */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Vig revenue</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Vig (Lifetime)" value={f(t.vigRevenueLifetime)} sub="All vig captured to date" icon={Coins} color="text-emerald-400" />
          <StatCard label="Vig (7d)" value={f(t.vigRevenue7d)} sub="Past 7 days" icon={Activity} color="text-emerald-400" />
          <StatCard label="Vig (24h)" value={f(t.vigRevenue24h)} sub="Last 24 hours" icon={Activity} color="text-emerald-400" />
          <StatCard label="Boost Sales" value={f(t.boostRake)} sub="₦70 Boost tickets sold" icon={Sparkles} color="text-amber-400" />
        </div>
      </div>

      {/* ── Revenue breakdown ───────────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Revenue breakdown</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="House Net" value={f(t.houseRevenueNet)} sub="Vig − VIP − insurance − promo" icon={Coins} color="text-emerald-400" />
          <StatCard label="Entry Rake" value={f(t.entryRake)} sub="1.5% of every stake" icon={Activity} color="text-emerald-400" />
          <StatCard label="Pool Rake" value={f(t.resolutionRake)} sub="10% at resolution (parimutuel)" icon={Activity} color="text-emerald-400" />
          <StatCard label="Total Rake" value={f(t.totalRake)} sub="Entry + Pool, gross" icon={Coins} color="text-amber-400" />
          <StatCard
            label="Locked-odds P&L"
            value={f(t.lockedSettlementPnl)}
            sub="Net book P&L on locked markets"
            icon={Activity}
            color={t.lockedSettlementPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
          <StatCard
            label="Multiplier P&L"
            value={f(t.multiplierPnl)}
            sub="Net book P&L on slips"
            icon={Activity}
            color={t.multiplierPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}
          />
        </div>
      </div>

      {/* ── User base + acquisition ─────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Users</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Users" value={u.total} icon={Users} color="text-blue-400" />
          <StatCard label="VIP Accounts" value={u.vip} sub="Special referral codes" icon={Sparkles} color="text-amber-400" />
          <StatCard label="New (24h)" value={u.new24h} icon={Users} color="text-emerald-400" />
          <StatCard label="Active Bettors (24h)" value={u.activeBettors24h} sub="Unique placers" icon={Activity} color="text-emerald-400" />
        </div>
      </div>

      {/* ── Betting activity (cohort-segmented) ─────────────────────── */}
      <CohortActivity cohorts={stats.cohorts} fallback={b} />


      {/* ── Markets ─────────────────────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Markets</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Open" value={m.open} icon={Activity} color="text-emerald-400" />
          <StatCard label="Locked" value={m.locked} icon={Lock} color="text-purple-400" />
          <StatCard label="Resolved" value={m.resolved} icon={CheckCircle2} color="text-emerald-400" />
          <StatCard label="Voided" value={m.voided} icon={Lock} color="text-muted-foreground" />
        </div>
      </div>

      {/* ── Referrals + VIP ─────────────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Referrals &amp; VIP</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Referrals" value={r.totalReferrals} sub="All-time signups" icon={Users} color="text-emerald-400" />
          <StatCard label="VIP Referrals" value={r.vipReferrals} sub={`${r.vipCodes} VIP codes active`} icon={Sparkles} color="text-amber-400" />
          <StatCard label="VIP Paid Out" value={f(t.vipPaidOut)} sub="From rake splits" icon={Gift} color="text-amber-400" />
          <StatCard label="Insurance Paid" value={f(t.insurancePaid)} sub="Bet insurance refunds" icon={Shield} color="text-blue-400" />
        </div>
      </div>

      {/* ── Wallet flow ─────────────────────────────────────────────── */}
      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Wallet</h3>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Lifetime Deposits" value={f(stats.deposits.lifetime)} icon={Coins} color="text-emerald-400" />
          <StatCard label="Pending Withdrawals" value={f(stats.withdrawals.pendingAmount)} sub={`${stats.withdrawals.pendingCount} requests`} icon={Activity} color="text-amber-400" />
          <StatCard label="Points Outstanding" value={(stats.points.outstanding || 0).toLocaleString()} sub="Across all users" icon={Sparkles} color="text-emerald-400" />
          <StatCard label="Last Refresh" value={new Date(stats.generatedAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })} sub="Auto-updates every 30s" icon={Activity} color="text-muted-foreground" />
        </div>
      </div>

      {/* ── Welcome Match promo ────────────────────────────────────── */}
      {stats.welcomePromo && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Welcome Match</h3>
            <Badge className={cn('text-[10px] h-5', stats.welcomePromo.active
              ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
              : 'bg-muted text-muted-foreground border-muted')}>
              {stats.welcomePromo.active ? 'LIVE' : 'PAUSED'}
            </Badge>
            {stats.welcomePromo.cutoff && (
              <span className="text-[10px] text-muted-foreground">
                Cutoff: {new Date(stats.welcomePromo.cutoff).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short' })}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard
              label="Claims (Total)"
              value={(stats.welcomePromo.totalClaims || 0).toLocaleString()}
              sub={`${stats.welcomePromo.claims24h} in last 24h`}
              icon={Gift}
              color="text-emerald-400"
            />
            <StatCard
              label="Credit Granted"
              value={f(stats.welcomePromo.creditGrantedTotal)}
              sub={`${f(stats.welcomePromo.creditGranted24h)} in last 24h`}
              icon={Coins}
              color="text-amber-400"
            />
            <StatCard
              label="Deposits Triggered"
              value={f(stats.welcomePromo.depositVolumeTriggered)}
              sub="Real ₦ pulled in by promo"
              icon={Activity}
              color="text-emerald-400"
            />
            <StatCard
              label="Promo Settings"
              value={`${Math.round(stats.welcomePromo.matchRatio * 100)}% / ${f(stats.welcomePromo.matchCap)}`}
              sub={`Min deposit ${f(stats.welcomePromo.minDeposit)}`}
              icon={Sparkles}
              color="text-blue-400"
            />
          </div>
        </div>
      )}

      {/* Reserve health — only renders once a locked-odds market exists  */}
      {/* (otherwise admin doesn't need to think about it). Live deployable */}
      {/* + dynamic cap + open exposure across the locked-odds book.        */}
      <ReserveHealthPanel />

      {/* Owner activity — quiet strip; only ever has rows when an owner */}
      {/* account exists. Filtered out of everything else on this panel.   */}
      <OwnerActivityPanel />

      {/* VIP leaderboard — ranks referral-code owners by signups + */}
      {/* deposits driven. Hides itself entirely if no VIPs exist.   */}
      <VipLeaderboardPanel />

      {/* Heartbeat status (unchanged) */}
      <Card className={cn('border', heartbeat.daysSince !== null && heartbeat.daysSince >= 25 ? 'border-red-500/40 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5')}>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className={cn('w-5 h-5', heartbeat.daysSince !== null && heartbeat.daysSince >= 25 ? 'text-red-400' : 'text-emerald-400')} />
            <div>
              <p className="text-sm font-medium">Escape Hatch Clock</p>
              <p className="text-xs text-muted-foreground">
                {heartbeat.lastFiredAt
                  ? `Last heartbeat: ${heartbeat.lastFiredAt.toLocaleDateString()} (${heartbeat.daysSince} days ago)`
                  : 'No heartbeat recorded'}
              </p>
            </div>
          </div>
          <Badge className={cn(heartbeat.daysSince !== null && heartbeat.daysSince >= 25 ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30')}>
            {30 - (heartbeat.daysSince || 0)} days remaining
          </Badge>
        </CardContent>
      </Card>

      <Link href="/admin/resolve">
        <div className="flex items-center justify-between p-4 bg-card border border-amber-500/20 rounded-xl hover:border-amber-500/40 transition-colors cursor-pointer">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-amber-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Resolve Markets</p>
              <p className="text-xs text-muted-foreground">Politics, Economics, Entertainment, Finance</p>
            </div>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </div>
      </Link>

      {/* Open Markets is a separate engine with its own house exposure, so it
          gets its own gate and its own dashboard rather than sharing the
          locked-odds screens. */}
      <Link href="/admin/open-markets">
        <div className="flex items-center justify-between p-4 bg-card border border-emerald-500/20 rounded-xl hover:border-emerald-500/40 transition-colors cursor-pointer">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Trading review</p>
              <p className="text-xs text-muted-foreground">Approve submissions · exposure dashboard</p>
            </div>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </div>
      </Link>

      <Link href="/admin/open-markets/control">
        <div className="flex items-center justify-between p-4 bg-card border border-emerald-500/20 rounded-xl hover:border-emerald-500/40 transition-colors cursor-pointer">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <ShieldAlert className="w-4 h-4 text-emerald-400" />
            </div>
            <div>
              <p className="text-sm font-medium">Trading — control panel</p>
              <p className="text-xs text-muted-foreground">Every market, every state · pause, halt, reschedule, delete</p>
            </div>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </div>
      </Link>
    </div>
  );
}

// ── Prediction Activity by cohort ────────────────────────────────────────
// Four parallel views over user_bets:
//   normal — non-VIP, non-owner real bettors (default view, "real users")
//   vip    — VIP-tier accounts
//   owner  — house-funded shadow bets (your monitoring stream)
//   all    — combined; what mixes everything for the absolute top-line
// Each cohort shows the same 4 metric cards so they're directly comparable.
function CohortActivity({ cohorts, fallback }: { cohorts?: any; fallback: any }) {
  const [view, setView] = useState<'normal' | 'vip' | 'owner' | 'all'>('normal');
  const tabs: Array<{ id: 'normal' | 'vip' | 'owner' | 'all'; label: string; color: string }> = [
    { id: 'normal', label: 'Normal',    color: 'text-blue-400' },
    { id: 'vip',    label: 'VIP',       color: 'text-amber-400' },
    { id: 'owner',  label: 'Owner',     color: 'text-fuchsia-300' },
    { id: 'all',    label: 'Everybody', color: 'text-emerald-400' },
  ];
  // Fall back to the legacy `bets` block if the analytics response is from
  // before cohorts shipped — so the panel keeps rendering during rollout.
  const data = cohorts?.[view] || {
    volume24h: fallback.volume24h,
    volume7d: fallback.volume7d,
    totalVolume: fallback.totalVolume,
    totalCount: fallback.totalCount,
    activeCount: fallback.activeCount,
    wonCount: fallback.wonCount,
    lostCount: fallback.lostCount,
    activeBettors24h: 0,
  };
  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Prediction Activity</h3>
        <div className="flex gap-1">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setView(t.id)}
              className={cn(
                'text-[10px] px-2 py-1 rounded-md border transition-colors',
                view === t.id
                  ? 'bg-card border-foreground/20 text-foreground'
                  : 'bg-transparent border-transparent text-muted-foreground hover:text-foreground'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Vol (24h)"     value={f(data.volume24h)}    sub={`${data.activeBettors24h} bettors`} icon={Activity} color={tabs.find(t => t.id === view)!.color} />
        <StatCard label="Vol (7d)"      value={f(data.volume7d)}     sub="Gross stakes"                       icon={Activity} color={tabs.find(t => t.id === view)!.color} />
        <StatCard label="Lifetime Vol"  value={f(data.totalVolume)}  sub={`${data.totalCount} bets`}          icon={Coins}    color="text-amber-400" />
        <StatCard label="Active Bets"   value={data.activeCount}     sub={`${data.wonCount} won · ${data.lostCount} lost`} icon={Activity} color="text-blue-400" />
      </div>
    </div>
  );
}

// ── Leaderboard preview (pre-rollout) ───────────────────────────────────
//
// What the public leaderboard will look like the day it launches. Ranks
// predictors by points (volume + win + referral), with Daily / Weekly /
// All-Time windows and the prize structure advertised on the teaser. The
// data (points_log) has accrued since launch, so this is real, not mock.
function timeAgoShort(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function LeaderboardPreviewPanel() {
  const [window, setWindow] = useState<'daily' | 'weekly' | 'alltime'>('weekly');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [publishedAt, setPublishedAt] = useState<Record<string, string | null>>({});
  const [publishing, setPublishing] = useState<'all' | 'one' | null>(null);
  const { toast } = useToast();

  const loadPublishStatus = useCallback(() => {
    fetch('/api/admin/leaderboard/publish', { credentials: 'include' })
      .then(r => r.json())
      .then(d => {
        const map: Record<string, string | null> = {};
        for (const s of d.snapshots || []) map[s.window] = s.published_at;
        setPublishedAt(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetch(`/api/admin/leaderboard?window=${window}&limit=3`, { credentials: 'include' })
      .then(r => r.json())
      .then(d => { if (alive) setRows(d.rows || []); })
      .catch(() => { if (alive) setRows([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [window]);

  useEffect(() => { loadPublishStatus(); }, [loadPublishStatus]);

  const publish = async (target?: 'daily' | 'weekly' | 'alltime') => {
    setPublishing(target ? 'one' : 'all');
    try {
      const res = await fetch('/api/admin/leaderboard/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(target ? { window: target } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Publish failed');
      toast({
        title: target ? `Published ${target}` : 'Published all windows',
        description: 'The public leaderboard now shows this snapshot.',
      });
      loadPublishStatus();
    } catch (e: any) {
      toast({ title: 'Publish failed', description: e.message, variant: 'destructive' });
    } finally {
      setPublishing(null);
    }
  };

  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;

  // Prize structure — top 3 only at rollout. Cash for #1, credit for #2/#3.
  const WEEKLY_PRIZES: Record<number, string> = {
    1: '₦20,000 cash', 2: '₦5,000 credit', 3: '₦3,000 credit',
  };
  const DAILY_PRIZES: Record<number, string> = { 1: '₦500 credit', 2: '₦300 credit', 3: '₦200 credit' };

  // Prize eligibility, per the teaser rules.
  const eligible = (r: any) => {
    if (window === 'weekly') return r.volume >= 2000 && r.resolvedBets >= 5;
    if (window === 'daily') return r.resolvedBets >= 3;
    return true;
  };
  const prizeFor = (rank: number) =>
    window === 'weekly' ? WEEKLY_PRIZES[rank] : window === 'daily' ? DAILY_PRIZES[rank] : undefined;

  return (
    <Card className="border-amber-500/20 bg-amber-500/[0.02]">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-amber-400" />
          Top 3 Predictors
          <Badge variant="outline" className="text-[9px] border-amber-500/30 text-amber-300">ADMIN ONLY — LIVE</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          This is the live board. The public leaderboard only shows what you publish below —
          publish this window to push it live to users.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex gap-1.5">
            {(['daily', 'weekly', 'alltime'] as const).map(w => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={cn(
                  'px-3 py-1.5 rounded-md text-xs font-medium capitalize transition-colors',
                  window === w ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                               : 'bg-muted/40 text-muted-foreground hover:bg-muted/60',
                )}
              >
                {w === 'alltime' ? 'All-Time' : w}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground">
              Public {window}: {timeAgoShort(publishedAt[window])}
            </span>
            <Button size="sm" variant="outline" className="h-7 text-xs" disabled={!!publishing} onClick={() => publish(window)}>
              {publishing === 'one' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
              Publish {window}
            </Button>
            <Button size="sm" className="h-7 text-xs bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 border border-amber-500/30" disabled={!!publishing} onClick={() => publish()}>
              {publishing === 'all' ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Upload className="w-3 h-3 mr-1" />}
              Publish all
            </Button>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No points earned in this window yet. Once users predict, they&rsquo;ll rank here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <p className="text-xs text-foreground/90 mb-2 font-medium">
              {window === 'weekly' ? 'Top 3 predictors this week' :
                window === 'daily' ? 'Top 3 predictors today' :
                'Top 3 predictors of all time'}
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left py-2 pr-2 font-medium w-8">#</th>
                  <th className="text-left py-2 px-2 font-medium">Predictor</th>
                  <th className="text-right py-2 px-2 font-medium">Points</th>
                  <th className="text-right py-2 px-2 font-medium">Accuracy</th>
                  <th className="text-right py-2 px-2 font-medium hidden sm:table-cell">Volume</th>
                  {window !== 'alltime' && <th className="text-right py-2 pl-2 font-medium">Prize</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const prize = prizeFor(r.rank);
                  const elig = eligible(r);
                  return (
                    <tr key={r.userId} className="border-b border-border/20">
                      <td className="py-2 pr-2 tabular-nums font-bold">
                        {r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : r.rank}
                      </td>
                      <td className="py-2 px-2 truncate max-w-[140px]">@{r.username}</td>
                      <td className="py-2 px-2 text-right tabular-nums font-semibold">{r.points.toLocaleString()}</td>
                      <td className="py-2 px-2 text-right tabular-nums">
                        {r.accuracy === null ? <span className="text-muted-foreground/50">—</span>
                          : <span className={r.accuracy >= 50 ? 'text-emerald-400' : 'text-muted-foreground'}>{r.accuracy}%</span>}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-muted-foreground hidden sm:table-cell">{f(r.volume)}</td>
                      {window !== 'alltime' && (
                        <td className="py-2 pl-2 text-right">
                          {prize ? (
                            <span className={cn('text-[10px]', elig ? 'text-amber-300' : 'text-muted-foreground/40 line-through')}>
                              {prize}
                            </span>
                          ) : ''}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="mt-3 space-y-1.5">
              {window !== 'alltime' && (
                <p className="text-[10px] text-muted-foreground">
                  Strikethrough = not yet prize-eligible
                  ({window === 'weekly' ? '₦2,000+ committed AND 5+ resolved predictions this week' : '3+ resolved predictions today'}).
                  Accuracy shown is all-time.
                </p>
              )}
              {/* Methodology + jackpot-qualification copy. The jackpot
                  itself is on hold — this line creates FOMO + drives
                  deposits while the engine is being ironed out. */}
              <p className="text-[10px] text-muted-foreground">
                <strong className="text-foreground">How the rank works:</strong> based on accuracy and volume.
                More resolved correct picks and more committed ₦ both push you up.
              </p>
              {window === 'weekly' && (
                <p className="text-[10px] text-amber-300/90">
                  🎯 The week&rsquo;s top 3 also qualify for next week&rsquo;s <strong>Jackpot Markets</strong>.
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Reserve health (locked-odds book monitoring) ────────────────────────
//
// Lights up only once there's at least one is_locked_odds market in
// the system — admins not piloting locked-odds shouldn't see this at
// all. Surfaces the dynamic-stake-cap regime so admins know what users
// can currently stake.
function ReserveHealthPanel() {
  const [data, setData] = useState<{
    deployable: number;
    floor: number;
    total: number;
    aggregateWorstCase: number;
    openSlipLiability?: number;
    lockedOddsMarketCount: number;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    // reserve_health + market_liability are service-role only via RLS,
    // so we proxy through an admin-authenticated endpoint instead of
    // hitting the tables directly with the browser-side anon client.
    // Pattern matches /api/admin/owner-activity etc.
    const load = async () => {
      try {
        const r = await fetch('/api/admin/reserve-health', { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (!alive) return;
        setData(d);
      } catch { /* non-critical */ }
    };
    const cleanup = pollWhileVisible(load, 60_000);
    return () => { alive = false; cleanup(); };
  }, []);

  // Hide entirely until there's a locked-odds market in play.
  if (!data || data.lockedOddsMarketCount === 0) return null;

  // Mirror the dynamic-cap schedule in lib/lockedOdds + the
  // place_bet_locked RPC. If these ever drift, update all three.
  const cap = data.deployable <= 0 ? 0
            : data.deployable < 50_000 ? 1500
            : data.deployable < 80_000 ? 3000
            : 5000;
  const stressed = data.deployable < data.floor * 0.6;

  const f = (n: number) => `₦${Math.round(n).toLocaleString()}`;

  return (
    <Card className={cn(
      'border',
      stressed ? 'border-amber-500/40 bg-amber-500/[0.04]'
                : 'border-emerald-500/30 bg-emerald-500/[0.03]',
    )}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <Shield className={cn('w-4 h-4', stressed ? 'text-amber-400' : 'text-emerald-400')} />
          Reserve Health
          <Badge className={cn(
            'text-[10px] h-5 ml-1',
            stressed ? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
                     : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
          )}>
            {stressed ? 'STRESSED' : 'HEALTHY'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="Deployable" value={f(data.deployable)} sub="Tier-2 spending capacity" icon={Coins} color="text-emerald-400" />
          <StatCard label="Floor" value={f(data.floor)} sub="Untouchable buffer" icon={Shield} color="text-muted-foreground" />
          <StatCard label="Total Reserve" value={f(data.total)} sub="Deployable + floor" icon={Coins} color="text-blue-400" />
          <StatCard label="Open Exposure" value={f(data.aggregateWorstCase + (data.openSlipLiability || 0))} sub={`Singles + ₦${Math.round(data.openSlipLiability || 0).toLocaleString()} slips`} icon={Activity} color={(data.aggregateWorstCase + (data.openSlipLiability || 0)) > data.deployable ? 'text-red-400' : 'text-amber-400'} />
          <StatCard label="Tier-2 Cap" value={cap === 0 ? 'PAUSED' : f(cap)} sub={cap === 0 ? 'Routed to parimutuel' : 'Per stake right now'} icon={Lock} color={cap === 0 ? 'text-red-400' : 'text-amber-300'} />
        </div>
        {data.aggregateWorstCase > data.deployable && (
          <p className="text-[11px] text-red-400 mt-3">
            Worst-case exposure exceeds deployable reserve. New Tier-2 stakes are tightening; settle a market to recover headroom.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Owner Activity (private monitoring for the founder cohort) ──────────
function OwnerActivityPanel() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/admin/owner-activity', { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setData(d);
      } catch { /* non-critical */ }
    };
    const cleanup = pollWhileVisible(load, 90_000);
    return () => { alive = false; cleanup(); };
  }, []);

  // No owners configured → render nothing. Keeps the dashboard clean for
  // anyone who hasn't been granted (e.g. ops folks loading admin).
  if (!data || !data.owners || data.owners.length === 0) return null;

  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;
  const a = data.aggregates;

  return (
    <Card className="border-fuchsia-500/20 bg-fuchsia-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-fuchsia-300">
          <Sparkles className="w-4 h-4" />
          Owner Activity
          <Badge className="text-[10px] h-5 bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30 ml-1">
            {data.owners.length} account{data.owners.length === 1 ? '' : 's'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Bets (lifetime)" value={a.lifetime.betsCount} sub={`${f(a.lifetime.stakeTotal)} staked`} icon={Activity} color="text-fuchsia-300" />
          <StatCard label="Bets (24h)" value={a.last24h.betsCount} sub={`${f(a.last24h.stakeTotal)} staked`} icon={Activity} color="text-fuchsia-300" />
          <StatCard label="Won (lifetime)" value={f(a.lifetime.payoutTotal)} sub="Pool winnings" icon={Coins} color="text-amber-400" />
          <StatCard label="Won (24h)" value={f(a.last24h.payoutTotal)} sub="Pool winnings" icon={Coins} color="text-amber-400" />
        </div>

        <div>
          <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Accounts</h4>
          <div className="space-y-1.5">
            {data.owners.map((o: any) => (
              <div key={o.user_id} className="flex items-center justify-between text-xs bg-card/40 rounded-md px-3 py-2 border border-fuchsia-500/10">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge className={cn('text-[10px] h-5', o.active
                    ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-muted text-muted-foreground border-muted')}>
                    {o.active ? 'ACTIVE' : 'PAUSED'}
                  </Badge>
                  <span className="truncate">{o.email || o.user_id}</span>
                </div>
                <div className="flex items-center gap-3 text-muted-foreground">
                  <span>{f(o.tngn_balance)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {data.recent.length > 0 && (
          <div>
            <h4 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Recent bets</h4>
            <div className="space-y-1">
              {data.recent.slice(0, 10).map((r: any) => (
                <div key={r.id} className="flex items-center justify-between gap-2 text-xs bg-card/40 rounded-md px-3 py-1.5 border border-fuchsia-500/10">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <Badge className={cn('text-[10px] h-5 shrink-0',
                      r.status === 'won'      ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                      r.status === 'lost'     ? 'bg-red-500/20 text-red-400 border-red-500/30' :
                      r.status === 'refunded' ? 'bg-muted text-muted-foreground border-muted' :
                                                'bg-blue-500/20 text-blue-400 border-blue-500/30')}>
                      {r.status.toUpperCase()}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate">
                        {r.market_question || `market #${r.market_id}`}
                        {r.outcome_label ? ` · ${r.outcome_label}` : ''}
                      </div>
                      {/* User attribution — Owner Activity's recent list is
                          flat across every owner, so without this the row
                          doesn't say who staked it. Show the @username
                          (the public identifier on the leaderboard + share
                          cards); fall back to first_name, then a shortened
                          UUID if nothing else is set. */}
                      <div className="text-[10px] text-muted-foreground/80 truncate">
                        {r.username ? `@${r.username}` : (r.first_name || `user ${String(r.user_id).slice(0, 8)}`)}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-muted-foreground shrink-0">
                    <span>stake {f(r.stake_tngn)}</span>
                    {r.status === 'won' && <span className="text-emerald-400">+{f(r.payout_tngn)}</span>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── VIP Leaderboard ──────────────────────────────────────────────────────
// Per-VIP performance roll-up. Renders nothing if there are no VIPs yet —
// keeps the dashboard clean pre-launch when only owner accounts exist.
function VipLeaderboardPanel() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch('/api/admin/vip-leaderboard', { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (alive) setData(d);
      } catch { /* non-critical */ }
    };
    const cleanup = pollWhileVisible(load, 90_000);
    return () => { alive = false; cleanup(); };
  }, []);

  if (!data || !data.vips || data.vips.length === 0) return null;

  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;

  return (
    <Card className="border-violet-500/20 bg-violet-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-violet-300">
          <Sparkles className="w-4 h-4" />
          VIP Leaderboard
          <Badge className="text-[10px] h-5 bg-violet-500/20 text-violet-300 border-violet-500/30 ml-1">
            {data.vips.length} VIP{data.vips.length === 1 ? '' : 's'}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {data.vips.map((v: any, i: number) => (
            <div key={v.vip_user_id} className="bg-card/40 rounded-md p-3 border border-violet-500/10">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-[10px] text-violet-400/80 tabular-nums w-5">#{i + 1}</span>
                  <span className="truncate text-sm font-medium">{v.email || v.vip_user_id}</span>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
                  <span>{v.signups} signup{v.signups === 1 ? '' : 's'}</span>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div>
                  <p className="text-muted-foreground uppercase tracking-wider">Rake earned</p>
                  <p className="text-emerald-400 font-semibold tabular-nums">{f(v.rake_earned)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground uppercase tracking-wider">Deposits driven</p>
                  <p className="text-foreground font-semibold tabular-nums">{f(v.referee_deposits)}</p>
                </div>
                <div>
                  <p className="text-muted-foreground uppercase tracking-wider">Bonus liability</p>
                  <p className="text-amber-400/80 font-semibold tabular-nums">{f(v.bonus_liability)}</p>
                </div>
              </div>
              {v.codes && v.codes.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-2.5">
                  {v.codes.map((c: any) => (
                    <Badge
                      key={c.code}
                      variant="outline"
                      className={cn(
                        'text-[10px] h-5 font-mono px-2',
                        c.is_active ? 'border-violet-500/30 text-violet-200' : 'opacity-50',
                      )}
                    >
                      {c.code} · {Math.round(c.rake_share_pct)}% rake · ₦{Math.round(c.signup_bonus_tngn).toLocaleString()} bonus
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Market Creation ───────────────────────────────────────────────────────
// ── Odds Calculator ───────────────────────────────────────────────────────
//
// Two modes:
//
//   FORWARD: pick seed size + per-outcome seed probability + vig, see the
//            opening odds users will face at common stake sizes.
//
//   REVERSE: paste target odds (e.g. from Sportybet) → tool derives the
//            seed probability split needed to produce those odds.
//            Sanity-checks the implied vig + shows a preview using the
//            actual locked-odds algorithm so you see the real opening
//            line (which is slightly tighter than the raw target because
//            of the thin-pool surcharge at market open).
//
// Pure exploration tool — no DB, no side effects. Supports 2–6 outcomes.
function OddsCalculatorPanel() {
  const [mode, setMode] = useState<'forward' | 'reverse'>('forward');
  const [category, setCategory] = useState('sports');
  const [numOutcomes, setNumOutcomes] = useState(2);
  const [seedSize, setSeedSize] = useState('10000');
  const [vigOverride, setVigOverride] = useState('');

  // Forward: probability for EACH outcome (sums to 1).
  const [seedProbs, setSeedProbs] = useState<string[]>(['0.5', '0.5']);
  // Reverse: target displayed odds for EACH outcome.
  const [targetOdds, setTargetOdds] = useState<string[]>(['1.85', '1.85']);
  // Bookmaker lookup state (Reverse mode only).
  const [lookupSport, setLookupSport] = useState<string>('soccer_epl');
  const [lookupQuery, setLookupQuery] = useState<string>('');
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupEvents, setLookupEvents] = useState<any[]>([]);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupConfigured, setLookupConfigured] = useState<boolean>(true);

  // Sports we expose in the lookup. Keys are The Odds API sport keys.
  const SPORTS = [
    { key: 'soccer_epl', label: 'EPL' },
    { key: 'soccer_uefa_champs_league', label: 'UEFA Champions League' },
    { key: 'soccer_uefa_europa_league', label: 'UEFA Europa League' },
    { key: 'soccer_spain_la_liga', label: 'La Liga' },
    { key: 'soccer_italy_serie_a', label: 'Serie A' },
    { key: 'soccer_germany_bundesliga', label: 'Bundesliga' },
    { key: 'soccer_france_ligue_one', label: 'Ligue 1' },
    { key: 'soccer_africa_cup_of_nations', label: 'AFCON' },
    { key: 'soccer_fifa_world_cup', label: 'World Cup' },
    { key: 'basketball_nba', label: 'NBA' },
    { key: 'mma_mixed_martial_arts', label: 'UFC / MMA' },
  ];

  const runLookup = async () => {
    setLookupLoading(true);
    setLookupError(null);
    try {
      const url = `/api/admin/lookup-odds?sport=${encodeURIComponent(lookupSport)}&q=${encodeURIComponent(lookupQuery)}`;
      const res = await fetch(url, { credentials: 'include' });
      const data = await res.json();
      if (!res.ok) {
        setLookupConfigured(data.configured !== false);
        setLookupError(data.error || 'Lookup failed');
        setLookupEvents([]);
      } else {
        setLookupConfigured(true);
        setLookupEvents(data.events || []);
        if ((data.events || []).length === 0) {
          setLookupError('No upcoming fixtures match. Try a different team or sport.');
        }
      }
    } catch (e: any) {
      setLookupError(e?.message || 'Lookup failed');
      setLookupEvents([]);
    } finally {
      setLookupLoading(false);
    }
  };

  // Pulling an event into the calculator: align outcome count to the
  // event's market shape (3 for 1X2, 2 for h2h-no-draw), copy the
  // averaged bookmaker odds into the target inputs.
  const applyEvent = (ev: any) => {
    const outcomes = ev.outcomes || [];
    if (outcomes.length < 2) return;
    setNumOutcomes(outcomes.length);
    setTargetOdds(outcomes.map((o: any) => String(o.avgOdds.toFixed(2))));
  };

  // Resize the per-outcome arrays when count changes.
  useEffect(() => {
    setSeedProbs(prev => {
      if (prev.length === numOutcomes) return prev;
      const even = (1 / numOutcomes).toFixed(2);
      return Array.from({ length: numOutcomes }, () => even);
    });
    setTargetOdds(prev => {
      if (prev.length === numOutcomes) return prev;
      // Default to fair odds at uniform implied probability + 8% vig.
      const fair = (numOutcomes / 1.08).toFixed(2);
      return Array.from({ length: numOutcomes }, () => fair);
    });
  }, [numOutcomes]);

  const seedSizeNum = Number(seedSize);
  const validSeed = Number.isFinite(seedSizeNum) && seedSizeNum >= 1_000 && seedSizeNum <= 14_000;
  const vigNum = vigOverride.trim() === '' ? undefined : Number(vigOverride);

  // Category default vig — mirrors VIG_DEFAULTS in lib/lockedOdds.
  const CATEGORY_VIGS: Record<string, number> = {
    sports: 0.07, sports_top: 0.06, sports_props: 0.07, combat: 0.08,
    economy: 0.09, crypto: 0.08, entertainment: 0.09, politics: 0.10, culture: 0.10,
  };
  const categoryVig = CATEGORY_VIGS[category] ?? 0.08;
  const effectiveVig = Number.isFinite(vigNum as number) ? (vigNum as number) : categoryVig;

  // ─── REVERSE math ─────────────────────────────────────────────────
  // Given target displayed odds, derive the seed probability split
  // implied by them. The implied vig is the sum-of-reciprocals minus 1;
  // if it's outside our [4%, 15%] bounds we flag it. Seed probabilities
  // are the normalised reciprocals so they sum to exactly 1 — these are
  // the chosen/total ratios the algorithm uses to open the line.
  const reverseTargets = targetOdds.map(s => Number(s));
  const reverseValid = reverseTargets.every(o => Number.isFinite(o) && o >= 1.05 && o <= 50);
  const reverseImpliedSum = reverseValid ? reverseTargets.reduce((a, o) => a + 1 / o, 0) : 0;
  const reverseImpliedVig = reverseValid ? reverseImpliedSum - 1 : 0;
  const reverseProbs = reverseValid && reverseImpliedSum > 0
    ? reverseTargets.map(o => (1 / o) / reverseImpliedSum)
    : [];
  // Warn if the implied vig is outside the engine's clamped band.
  const reverseVigWarning =
    reverseValid && (reverseImpliedVig < 0.04 || reverseImpliedVig > 0.15)
      ? `Implied vig is ${(reverseImpliedVig * 100).toFixed(1)}% — outside the engine band (4–15%). Adjust your odds so the implied vig sits inside that range.`
      : null;

  // ─── FORWARD probability validation ─────────────────────────────
  const forwardProbs = seedProbs.map(s => Number(s));
  const forwardProbSum = forwardProbs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
  const forwardProbsValid =
    forwardProbs.every(p => Number.isFinite(p) && p > 0.02 && p < 0.98) &&
    Math.abs(forwardProbSum - 1) < 0.005;

  // ─── Seed split (the actual pool numbers fed to the algorithm) ──
  const seedPool: number[] = (() => {
    if (!validSeed) return [];
    if (mode === 'forward') {
      if (!forwardProbsValid) return [];
      const out = forwardProbs.map(p => Math.round(seedSizeNum * p));
      // absorb rounding crumb into outcome 0 so sum is exact
      const drift = seedSizeNum - out.reduce((a, n) => a + n, 0);
      out[0] += drift;
      return out;
    }
    // reverse
    if (!reverseValid || reverseProbs.length !== numOutcomes) return [];
    const out = reverseProbs.map(p => Math.round(seedSizeNum * p));
    const drift = seedSizeNum - out.reduce((a, n) => a + n, 0);
    out[0] += drift;
    return out;
  })();

  // Stakes shown in the opening-odds preview table.
  const SAMPLE_STAKES = [200, 500, 1000, 5000];

  const grid = seedPool.length === numOutcomes && seedPool.length >= 2
    ? SAMPLE_STAKES.map(stake => ({
        stake,
        perOutcome: seedPool.map((_, i) => {
          try {
            return calculateLockedOdds(
              { category, seedPool, realPool: seedPool.map(() => 0), vigPctOverride: vigNum },
              stake, i, {}, { deployableTngn: 120_000, floorTngn: 30_000 },
            );
          } catch {
            return null;
          }
        }),
      }))
    : null;

  const totalSeed = seedPool.reduce((a, b) => a + b, 0);

  return (
    <Card className="border-blue-500/20 bg-blue-500/[0.02]">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Coins className="w-4 h-4 text-blue-400" />
          Odds Calculator
          <Badge variant="outline" className="text-[9px] border-blue-500/30 text-blue-300">EXPLORE</Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {mode === 'forward'
            ? 'Tune seed size, probability and vig — see the opening line you’ll quote.'
            : 'Paste the odds you want (e.g. from Sportybet) — we derive the seed split to produce them.'}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Mode toggle */}
        <div className="inline-flex bg-muted/40 rounded-md p-0.5">
          {(['forward', 'reverse'] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'px-3 py-1.5 rounded text-xs font-medium transition-colors',
                mode === m ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {m === 'forward' ? 'Forward · seed → odds' : 'Reverse · odds → seed'}
            </button>
          ))}
        </div>

        {/* Common controls */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="sports">Sports (7%)</SelectItem>
                <SelectItem value="sports_top">Sports — top (6%)</SelectItem>
                <SelectItem value="sports_props">Sports — props (7%)</SelectItem>
                <SelectItem value="combat">Combat (8%)</SelectItem>
                <SelectItem value="economy">Economy (9%)</SelectItem>
                <SelectItem value="crypto">Crypto (8%)</SelectItem>
                <SelectItem value="entertainment">Entertainment (9%)</SelectItem>
                <SelectItem value="politics">Politics (10%)</SelectItem>
                <SelectItem value="culture">Culture (10%)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Outcomes</Label>
            <Select value={String(numOutcomes)} onValueChange={v => setNumOutcomes(Number(v))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="2">2 (Yes / No)</SelectItem>
                <SelectItem value="3">3 (e.g. 1X2)</SelectItem>
                <SelectItem value="4">4</SelectItem>
                <SelectItem value="5">5</SelectItem>
                <SelectItem value="6">6</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Seed size (₦)</Label>
            <Input type="number" value={seedSize} onChange={e => setSeedSize(e.target.value)}
              className={cn(!validSeed && 'border-red-500/40')} />
            <p className="text-[10px] text-muted-foreground">₦1k – ₦14k</p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Vig override</Label>
            <Input type="number" step={0.01} placeholder={`default ${(categoryVig * 100).toFixed(0)}%`} value={vigOverride}
              onChange={e => setVigOverride(e.target.value)} />
            <p className="text-[10px] text-muted-foreground">Blank = category default</p>
          </div>
        </div>

        {/* MODE-SPECIFIC INPUTS */}
        {mode === 'forward' ? (
          <div className="space-y-2">
            <Label className="text-xs">Seed probability per outcome (must sum to 1.00)</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {seedProbs.map((p, i) => (
                <div key={i} className="space-y-1">
                  <p className="text-[10px] text-muted-foreground">Outcome {i}</p>
                  <Input
                    type="number" step={0.01} min={0.02} max={0.98}
                    value={p}
                    onChange={e => setSeedProbs(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                  />
                </div>
              ))}
            </div>
            <p className={cn(
              'text-[10px]',
              Math.abs(forwardProbSum - 1) > 0.005 ? 'text-red-400' : 'text-muted-foreground',
            )}>
              Sum: {forwardProbSum.toFixed(3)} {Math.abs(forwardProbSum - 1) > 0.005 && '— must equal 1.000'}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Live bookmaker lookup → auto-fill the target odds below.
                Free-tier The Odds API; cached server-side for 60 min. */}
            <div className="rounded-md border border-blue-500/20 bg-blue-500/[0.04] p-2.5 space-y-2">
              <div className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-blue-300" />
                <p className="text-xs font-semibold text-blue-300">Get odds from a real fixture</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2">
                <Select value={lookupSport} onValueChange={setLookupSport}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SPORTS.map(s => (
                      <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  className="h-8 text-xs"
                  placeholder="e.g. Arsenal — leave blank to see the next 20 fixtures"
                  value={lookupQuery}
                  onChange={e => setLookupQuery(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') runLookup(); }}
                />
                <Button size="sm" onClick={runLookup} disabled={lookupLoading} className="h-8 text-xs">
                  {lookupLoading ? <><Loader2 className="w-3 h-3 animate-spin mr-1" />Searching</> : 'Search'}
                </Button>
              </div>
              {!lookupConfigured && (
                <p className="text-[11px] text-amber-300">
                  Odds lookup not configured. Add <code className="font-mono">THE_ODDS_API_KEY</code> to Netlify env vars
                  (sign up at <a href="https://the-odds-api.com/account/" target="_blank" rel="noreferrer" className="underline">the-odds-api.com</a>, free tier).
                </p>
              )}
              {lookupError && lookupConfigured && (
                <p className="text-[11px] text-amber-300">{lookupError}</p>
              )}
              {lookupEvents.length > 0 && (
                <div className="space-y-1.5 max-h-56 overflow-y-auto">
                  {lookupEvents.map(ev => {
                    const dt = new Date(ev.commenceAt);
                    return (
                      <button
                        key={ev.id}
                        type="button"
                        onClick={() => applyEvent(ev)}
                        className="w-full text-left rounded-md border border-border/40 bg-background/40 hover:bg-blue-500/10 hover:border-blue-500/40 px-2.5 py-2 transition-colors"
                      >
                        <div className="flex justify-between items-baseline gap-2 text-xs">
                          <span className="font-medium truncate">{ev.homeTeam} v {ev.awayTeam}</span>
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            {dt.toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                          {ev.outcomes.map((o: any, i: number) => (
                            <span key={i}>
                              <span className="text-foreground">{o.avgOdds.toFixed(2)}×</span>{' '}
                              <span className="text-muted-foreground/80">{o.name}</span>
                            </span>
                          ))}
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground/70">
                          Avg across {ev.outcomes[0]?.bookmakerCount || 0} bookmakers · tap to load
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <Label className="text-xs">Target odds per outcome (what the user should see)</Label>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
              {targetOdds.map((o, i) => (
                <div key={i} className="space-y-1">
                  <p className="text-[10px] text-muted-foreground">Outcome {i}</p>
                  <Input
                    type="number" step={0.01} min={1.05} max={50}
                    placeholder="e.g. 1.85"
                    value={o}
                    onChange={e => setTargetOdds(prev => prev.map((v, j) => j === i ? e.target.value : v))}
                  />
                </div>
              ))}
            </div>
            {reverseValid && (
              <div className="text-[10px] text-muted-foreground">
                Implied vig from your odds:{' '}
                <span className={reverseVigWarning ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
                  {(reverseImpliedVig * 100).toFixed(2)}%
                </span>
              </div>
            )}
            {reverseVigWarning && (
              <p className="text-[11px] text-amber-300">{reverseVigWarning}</p>
            )}
          </div>
        )}

        {/* Seed split readout — both modes */}
        {seedPool.length >= 2 && (
          <div className="rounded-md bg-card/40 border border-border/40 p-2.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Seed split</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {seedPool.map((s, i) => (
                <div key={i} className="bg-background/40 rounded px-2 py-1 border border-border/30">
                  <span className="text-muted-foreground">Outcome {i}: </span>
                  <span className="font-semibold">₦{s.toLocaleString()}</span>
                  <span className="text-muted-foreground"> · {totalSeed > 0 ? Math.round((s / totalSeed) * 100) : 0}%</span>
                </div>
              ))}
            </div>
            {mode === 'reverse' && (
              <p className="text-[10px] text-muted-foreground mt-2">
                Use these seed values on the Create form: probability {seedPool.length === 2 ? `for outcome 0 = ${(seedPool[0] / totalSeed).toFixed(3)}` : 'shown above per outcome'}, total seed ₦{totalSeed.toLocaleString()}.
              </p>
            )}
          </div>
        )}

        {/* Opening odds preview — both modes use the SAME algorithm */}
        {grid ? (
          <div className="overflow-x-auto">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
              Opening line — what users will see
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border/40">
                  <th className="text-left py-2 pr-3 font-medium">Stake</th>
                  {seedPool.map((_, i) => (
                    <th key={i} className="text-left py-2 px-3 font-medium">Outcome {i}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map(row => (
                  <tr key={row.stake} className="border-b border-border/20">
                    <td className="py-2 pr-3 tabular-nums">₦{row.stake.toLocaleString()}</td>
                    {row.perOutcome.map((r, i) => (
                      <td key={i} className="py-2 px-3">
                        {r ? (
                          <div className="flex flex-col">
                            <span className="font-bold tabular-nums">{r.lockedOdds.toFixed(2)}×</span>
                            <span className="text-[10px] text-muted-foreground">
                              ₦{r.floorPayout.toLocaleString()}–₦{r.upperPayout.toLocaleString()} · vig {(r.vigApplied * 100).toFixed(1)}%
                            </span>
                          </div>
                        ) : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-muted-foreground mt-2">
              {mode === 'reverse'
                ? 'Note: the displayed odds at opening are slightly tighter than your targets — the engine adds a 2% thin-pool surcharge on fresh markets that fades as real volume comes in.'
                : 'Odds shorten as stake grows (slippage protection). Bigger seed = more stable opening line.'}
            </p>
          </div>
        ) : (
          <div className="rounded-md bg-amber-500/[0.06] border border-amber-500/20 p-3 text-xs text-amber-200/90">
            {!validSeed && <p>• Seed size must be between ₦1,000 and ₦14,000.</p>}
            {mode === 'forward' && validSeed && !forwardProbsValid && (
              <p>• Each probability must be 0.02–0.98 and the row must sum to 1.000.</p>
            )}
            {mode === 'reverse' && validSeed && !reverseValid && (
              <p>• Each target odds must be between 1.05 and 50.</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── One place for every creation path ───────────────────────────────────
//
// Manual (+ Clone & Edit + saved templates), AI Generate, and Bulk Import
// (CSV) used to live in two separate top-level tabs — this puts all three
// under a single "Create" tab with a mode switch, so there's one place to
// remember. Every mode carries its own locked-odds config (on by default,
// since every market is expected to have it now); nothing here changes
// that, it just changes where each tool lives.
function MarketCreationHub() {
  const [mode, setMode] = useState<'manual' | 'ai' | 'bulk'>('manual');
  const MODES = [
    { key: 'manual' as const, label: 'Manual', icon: Plus },
    { key: 'ai' as const, label: 'AI Generate', icon: Sparkles },
    { key: 'bulk' as const, label: 'Bulk Import (CSV)', icon: Upload },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-1.5 p-1 bg-muted/30 rounded-lg w-fit">
        {MODES.map(m => (
          <button
            key={m.key}
            type="button"
            onClick={() => setMode(m.key)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              mode === m.key ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <m.icon className="w-3.5 h-3.5" />
            {m.label}
          </button>
        ))}
      </div>

      {mode === 'manual' && (
        <div className="space-y-6">
          <OddsCalculatorPanel />
          <CreateMarketPanel />
        </div>
      )}
      {mode === 'ai' && <AIMarketGenerator />}
      {mode === 'bulk' && <BulkImportPanel />}
    </div>
  );
}

function CreateMarketPanel() {
  const { toast } = useToast();
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('sports');
  const [options, setOptions] = useState<string[]>(['Home Win', 'Draw', 'Away Win']);
  const [closesAt, setClosesAt] = useState('');
  const [fixtureId, setFixtureId] = useState('');
  const [parentMarketId, setParentMarketId] = useState<string>('');
  const [parentOptions, setParentOptions] = useState<Array<{ id: number; question: string }>>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  // ─── Locked-odds config ────────────────────────────────────────────
  // On by default — every market created going forward is expected to
  // carry locked odds; parimutuel (unchecking this) is still fully
  // supported for the rare case that calls for it, and remains the
  // live fallback path when the reserve is under stress.
  const [isLockedOdds, setIsLockedOdds] = useState(true);
  const [seedSize, setSeedSize] = useState<string>('10000');
  const [seedProbability, setSeedProbability] = useState<string>('0.5'); // binary YES
  // Per-outcome probabilities for markets with 3+ outcomes. Synced to
  // numOutcomes by the effect below — admins can override the default
  // uniform split (e.g. tilt 1X2 toward the home side).
  const [seedProbsMulti, setSeedProbsMulti] = useState<string[]>(['0.40', '0.30', '0.30']);
  const [vigOverride, setVigOverride] = useState<string>(''); // empty = use default per category
  const [reserveDeployable, setReserveDeployable] = useState<number | null>(null);

  // Scheduling — leave off (default) to open immediately, same as
  // today. When on, the market inserts as 'scheduled' and the
  // open-scheduled cron flips it to 'open' at opensAt.
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [opensAt, setOpensAt] = useState('');

  // Carried through by "Clone & Edit" but not exposed as their own
  // inputs on this form (the AI generator is the only other writer of
  // these fields today) — kept so a clone of an AI-generated sports
  // market doesn't silently lose its sport/team/description on save.
  const [clonedSport, setClonedSport] = useState('');
  const [clonedHomeTeam, setClonedHomeTeam] = useState('');
  const [clonedAwayTeam, setClonedAwayTeam] = useState('');
  const [clonedLeagueCode, setClonedLeagueCode] = useState('');
  const [clonedDescription, setClonedDescription] = useState('');
  // Which hub picker option is selected, if any — '' means "custom", which
  // falls through to the free-text Sport tag / Hub tag inputs below. Kept
  // separate from clonedSport/clonedLeagueCode so picking a hub can drive
  // both of those AND category together in one place, rather than an admin
  // having to get sport, league_code and category right independently.
  const [hubOptionId, setHubOptionId] = useState('');

  // Saved market "shapes" for one-click reuse — see market_templates.
  const [templates, setTemplates] = useState<any[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [templateNameInput, setTemplateNameInput] = useState('');
  const [showTemplateNameInput, setShowTemplateNameInput] = useState(false);

  const loadTemplates = useCallback(() => {
    setTemplatesLoading(true);
    fetch('/api/admin/market-templates', { headers: adminHeaders(), credentials: 'include' })
      .then(r => r.json())
      .then(d => setTemplates(d.templates || []))
      .catch(() => setTemplates([]))
      .finally(() => setTemplatesLoading(false));
  }, []);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const deleteTemplate = async (id: number) => {
    setTemplates(prev => prev.filter(t => t.id !== id));
    try {
      const res = await fetch(`/api/admin/market-templates?id=${id}`, {
        method: 'DELETE',
        headers: adminHeaders(),
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Delete failed');
    } catch {
      toast({ title: 'Failed to delete template', variant: 'destructive' });
      loadTemplates();
    }
  };

  const updateOption = (idx: number, value: string) => {
    setOptions(prev => prev.map((o, i) => (i === idx ? value : o)));
  };
  const removeOption = (idx: number) => {
    setOptions(prev => prev.filter((_, i) => i !== idx));
  };
  const addOption = () => {
    if (options.length >= 50) {
      toast({ title: 'Max 50 options per market', variant: 'destructive' });
      return;
    }
    setOptions(prev => [...prev, '']);
  };
  const numOutcomesNow = options.map(o => o.trim()).filter(Boolean).length;

  // Shared prefill core for both "Clone & Edit" (from a past market row)
  // and "quick-create from template" (from a saved market_templates
  // row) — both shapes carry the same field names. Close time, fixture
  // ID and parent link are deliberately left blank/cleared since both
  // are starting points for a NEW instance, never a past one's
  // schedule. Locked-odds config is converted back from the stored
  // seed_pool amounts into probabilities so it round-trips through the
  // same validation path as a hand-typed one.
  const prefillMarketShape = (m: any) => {
    const cleanOptions = Array.isArray(m.options) && m.options.length >= 2 ? m.options as string[] : ['', ''];
    setQuestion(m.question || '');
    setCategory(m.category || 'sports');
    setOptions(cleanOptions);
    setClosesAt('');
    setFixtureId('');
    setParentMarketId(parentOptions.some(p => p.id === m.parent_market_id) ? String(m.parent_market_id) : '');
    setClonedSport(m.sport || '');
    setClonedHomeTeam(m.home_team || '');
    setClonedAwayTeam(m.away_team || '');
    setClonedLeagueCode(m.league_code || '');
    setClonedDescription(m.description || '');
    setScheduleEnabled(false);
    setOpensAt('');

    if (m.is_locked_odds) {
      const pool = m.seed_pool || {};
      const values = cleanOptions.map((_: string, i: number) => Number(pool[String(i)] || 0));
      const total = values.reduce((a: number, v: number) => a + v, 0);
      setIsLockedOdds(true);
      setSeedSize(total > 0 ? String(Math.round(total)) : '10000');
      if (cleanOptions.length === 2) {
        const p = total > 0 ? values[0] / total : Number(m.seed_probability ?? 0.5);
        setSeedProbability(p.toFixed(2));
      } else if (total > 0) {
        setSeedProbsMulti(values.map((v: number) => (v / total).toFixed(2)));
      }
      setVigOverride(m.vig_pct != null ? String(m.vig_pct) : '');
    } else {
      setIsLockedOdds(false);
    }
  };

  const applyClone = (m: any) => {
    prefillMarketShape(m);
    toast({ title: `Cloned market #${m.id}`, description: 'Set a new close time (and schedule, if wanted) before creating.' });
  };

  const applyTemplate = (t: any) => {
    prefillMarketShape(t);
    if (t.default_closes_in_hours) {
      const d = new Date(Date.now() + Number(t.default_closes_in_hours) * 60 * 60 * 1000);
      // datetime-local input format: YYYY-MM-DDTHH:mm, in local time.
      const pad = (n: number) => String(n).padStart(2, '0');
      setClosesAt(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
    toast({ title: `Loaded template "${t.name}"`, description: 'Review the question and close time before creating.' });
  };

  // Re-shape seedProbsMulti when the options count changes so the inputs
  // always match the actual outcomes — and regenerate cleanly when the
  // length differs. Preserving stale slot values across a resize would
  // leave the sum off 1.00 by default, forcing the admin to debug their
  // own form. A clean uniform split (with the rounding crumb absorbed by
  // the last slot so the sum is exactly 1.00) is more predictable.
  useEffect(() => {
    if (numOutcomesNow < 3) return;
    setSeedProbsMulti(prev => {
      if (prev.length === numOutcomesNow) return prev;
      const uniform = Math.floor((1 / numOutcomesNow) * 100) / 100;
      const next: string[] = Array.from({ length: numOutcomesNow }, () => uniform.toFixed(2));
      const drift = 1 - uniform * numOutcomesNow;
      // Absorb crumb in the last slot so the sum equals 1.00 exactly.
      next[numOutcomesNow - 1] = (uniform + drift).toFixed(2);
      return next;
    });
  }, [numOutcomesNow]);

  // Fetch the deployable reserve so the form can show a budget hint
  // before submission. Goes through the admin server endpoint because
  // reserve_health is now security_invoker = on and house_reserve is
  // service-role only — a direct client read returns null. Failures
  // are silent — the create endpoint enforces the real check.
  useEffect(() => {
    if (!isLockedOdds) return;
    fetch('/api/admin/reserve-health', { headers: adminHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && typeof data.deployable !== 'undefined') {
          setReserveDeployable(Number(data.deployable));
        }
      })
      .catch(() => { /* leave hint unset on failure */ });
  }, [isLockedOdds]);

  const PRESETS = [
    { label: '1X2 (Football)', options: ['Home Win', 'Draw', 'Away Win'] },
    { label: 'Yes/No', options: ['Yes', 'No'] },
    { label: 'Over/Under 2.5', options: ['Over 2.5', 'Under 2.5'] },
    { label: 'BTTS', options: ['Yes - Both Score', 'No - Both Score'] },
    { label: 'Win/Lose', options: ['Win', 'Lose'] },
  ];

  // Top-level parent markets in open/locked status — the only valid sub-market
  // parents. We don't allow nesting under a resolved/voided market.
  useEffect(() => {
    supabase
      .from('markets')
      .select('id, question, status, parent_market_id')
      .in('status', ['open', 'locked'])
      .is('parent_market_id', null)
      .order('id', { ascending: false })
      .limit(100)
      .then(({ data }) => setParentOptions((data as any[]) || []));
  }, []);

  const handleCreate = async () => {
    if (!question || !closesAt) {
      toast({ title: 'Question and close time are required', variant: 'destructive' });
      return;
    }

    const cleanedOptions = options.map(o => o.trim()).filter(Boolean);
    if (cleanedOptions.length < 2) {
      toast({ title: 'At least 2 options required', variant: 'destructive' });
      return;
    }

    if (scheduleEnabled && !opensAt) {
      toast({ title: 'Pick an open time, or turn scheduling off', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      // For 3+ outcomes, convert per-outcome probabilities into an
      // explicit seed pool (₦ per outcome) so the API stores the exact
      // split the admin previewed. For binary markets we still pass
      // seedProbability and let the API derive the split.
      let multiSeedPool: number[] | null = null;
      if (isLockedOdds && cleanedOptions.length >= 3) {
        const probs = seedProbsMulti.slice(0, cleanedOptions.length).map(s => Number(s));
        const probSum = probs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
        if (!probs.every(p => Number.isFinite(p) && p >= 0.02 && p <= 0.98) || Math.abs(probSum - 1) > 0.005) {
          toast({
            title: 'Seed probabilities invalid',
            description: 'Each outcome must be 0.02–0.98 and they must sum to 1.00.',
            variant: 'destructive',
          });
          setIsSubmitting(false);
          return;
        }
        const seedSizeNum = Number(seedSize);
        const raw = probs.map(p => Math.round(seedSizeNum * p));
        // Crumb-correct so the sum equals seedSize exactly.
        const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
        raw[0] += drift;
        multiSeedPool = raw;
      }

      const lockedPayload = isLockedOdds ? {
        isLockedOdds: true,
        seedSizeTngn: Number(seedSize),
        seedProbability: cleanedOptions.length === 2 ? Number(seedProbability) : null,
        seedPool: multiSeedPool,
        vigPct: vigOverride.trim() === '' ? null : Number(vigOverride),
      } : { isLockedOdds: false };

      const res = await fetch('/api/admin/market', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          question,
          category,
          options: cleanedOptions,
          closesAt: new Date(closesAt).toISOString(),
          fixtureId: fixtureId ? parseInt(fixtureId) : null,
          parentMarketId: parentMarketId ? parseInt(parentMarketId) : null,
          opensAt: scheduleEnabled && opensAt ? new Date(opensAt).toISOString() : null,
          sport: clonedSport || undefined,
          homeTeam: clonedHomeTeam || undefined,
          awayTeam: clonedAwayTeam || undefined,
          leagueCode: clonedLeagueCode || undefined,
          description: clonedDescription || undefined,
          ...lockedPayload,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }

      toast({
        title: data.market.status === 'scheduled' ? `Market scheduled! ID: ${data.market.id}` : `Market created! ID: ${data.market.id}`,
        description: data.market.status === 'scheduled'
          ? `Opens automatically ${new Date(data.market.opens_at).toLocaleString()}.`
          : (parentMarketId ? `Linked as sub-market under #${parentMarketId}` : undefined),
      });
      setQuestion('');
      setClosesAt('');
      setFixtureId('');
      setParentMarketId('');
      setScheduleEnabled(false);
      setOpensAt('');
      setClonedSport('');
      setClonedHomeTeam('');
      setClonedAwayTeam('');
      setClonedLeagueCode('');
      setClonedDescription('');
    } catch (err: any) {
      toast({ title: 'Failed to create market', description: err.message, variant: 'destructive' });
    } finally { setIsSubmitting(false); }
  };

  // Save the current form (minus closesAt/fixtureId/parentMarketId,
  // same instance-specific fields Clone & Edit clears) as a named,
  // reusable template. Recomputes the seed pool with the same math
  // handleCreate uses so the template round-trips through
  // prefillMarketShape identically to a cloned market.
  const handleSaveTemplate = async () => {
    const name = templateNameInput.trim();
    if (!name) {
      toast({ title: 'Give the template a name', variant: 'destructive' });
      return;
    }
    const cleanedOptions = options.map(o => o.trim()).filter(Boolean);
    if (cleanedOptions.length < 2) {
      toast({ title: 'At least 2 options required', variant: 'destructive' });
      return;
    }

    let seedPool: Record<string, number> | null = null;
    if (isLockedOdds) {
      const seedSizeNum = Number(seedSize) || 0;
      if (cleanedOptions.length === 2) {
        const p = Number(seedProbability) || 0.5;
        const yes = Math.round(seedSizeNum * p);
        seedPool = { '0': yes, '1': seedSizeNum - yes };
      } else {
        const probs = seedProbsMulti.slice(0, cleanedOptions.length).map(s => Number(s) || 0);
        const raw = probs.map(p => Math.round(seedSizeNum * p));
        const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
        raw[0] += drift;
        seedPool = Object.fromEntries(raw.map((v, i) => [String(i), v]));
      }
    }

    setSavingTemplate(true);
    try {
      const res = await fetch('/api/admin/market-templates', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          name,
          question,
          category,
          options: cleanedOptions,
          sport: clonedSport || undefined,
          homeTeam: clonedHomeTeam || undefined,
          awayTeam: clonedAwayTeam || undefined,
          leagueCode: clonedLeagueCode || undefined,
          description: clonedDescription || undefined,
          isLockedOdds,
          seedPool,
          seedProbability: isLockedOdds && cleanedOptions.length === 2 ? Number(seedProbability) : null,
          vigPct: isLockedOdds && vigOverride.trim() !== '' ? Number(vigOverride) : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save template');
      toast({ title: `Template "${name}" saved` });
      setTemplateNameInput('');
      setShowTemplateNameInput(false);
      loadTemplates();
    } catch (err: any) {
      toast({ title: 'Failed to save template', description: err.message, variant: 'destructive' });
    } finally {
      setSavingTemplate(false);
    }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Create Market</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {!templatesLoading && templates.length > 0 && (
          <div className="space-y-1.5 rounded-lg border border-dashed border-muted-foreground/30 p-3">
            <Label className="text-xs font-medium">Quick-create from a saved template</Label>
            <div className="flex flex-wrap gap-1.5">
              {templates.map((t) => (
                <div key={t.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => applyTemplate(t)}
                    className="text-xs pl-2.5 pr-6 py-1.5 rounded-md bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1.5"
                  >
                    {t.is_locked_odds && <Sparkles className="w-3 h-3 text-amber-400" />}
                    {t.name}
                  </button>
                  <button
                    type="button"
                    title="Delete template"
                    onClick={() => deleteTemplate(t.id)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-opacity"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <CloneMarketPicker onSelect={applyClone} />

        <div className="flex justify-end">
          {!showTemplateNameInput ? (
            <Button type="button" size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => setShowTemplateNameInput(true)}>
              <Copy className="w-3 h-3" /> Save current form as template
            </Button>
          ) : (
            <div className="flex items-center gap-1.5 w-full">
              <Input
                placeholder='Template name, e.g. "EPL 1X2"'
                value={templateNameInput}
                onChange={e => setTemplateNameInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSaveTemplate()}
                className="h-8 text-xs"
              />
              <Button type="button" size="sm" className="h-8 text-xs shrink-0" disabled={savingTemplate} onClick={handleSaveTemplate}>
                {savingTemplate ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Save'}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-8 text-xs shrink-0" onClick={() => { setShowTemplateNameInput(false); setTemplateNameInput(''); }}>
                Cancel
              </Button>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label>Category</Label>
          <Select
            value={category}
            onValueChange={v => { setCategory(v); setHubOptionId(''); }}
          >
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sports">Sports</SelectItem>
              <SelectItem value="politics">Politics</SelectItem>
              <SelectItem value="economics">Economics</SelectItem>
              <SelectItem value="entertainment">Entertainment</SelectItem>
              <SelectItem value="finance">Finance / Crypto</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Which hub, if any. Picking one sets category + sport + league_code
            together from lib/lockedOddsHubOptions.ts — the exact same config
            the hub pages read to decide what to show. Before this there were
            two free-text inputs and a hint written only for BBN; an admin
            typing "basketball" from memory with no validation is exactly how
            a market ends up saved and permanently invisible on its hub. The
            free-text pair stays below as "Custom" for anything that does not
            fit one of these yet. */}
        <div className="space-y-2">
          <Label>Show on a hub <span className="text-muted-foreground font-normal">(optional)</span></Label>
          <Select
            // Radix's Select refuses an empty-string item value, so "Custom"
            // is the sentinel 'none' here — same convention this form
            // already uses for "no parent market" below.
            value={hubOptionId || 'none'}
            onValueChange={id => {
              if (id === 'none') { setHubOptionId(''); return; } // leave the free-text fields as they are
              setHubOptionId(id);
              const opt = getLockedOddsHubOption(id);
              if (!opt) return;
              setCategory(opt.category);
              setClonedSport(opt.sport);
              setClonedLeagueCode(opt.leagueCode || '');
            }}
          >
            <SelectTrigger><SelectValue placeholder="Custom (type sport/hub tags below)" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Custom (type sport/hub tags below)</SelectItem>
              {groupedLockedOddsHubOptions().map(({ groupLabel, options }) => (
                <SelectGroup key={groupLabel}>
                  <SelectLabel>{groupLabel}</SelectLabel>
                  {options.map(o => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
          {hubOptionId && (() => {
            const opt = getLockedOddsHubOption(hubOptionId);
            return opt ? (
              <p className="text-[11px] text-muted-foreground">
                Sets category <code className="bg-muted/40 px-1 py-0.5 rounded">{opt.category}</code>,
                sport tag <code className="bg-muted/40 px-1 py-0.5 rounded">{opt.sport}</code>
                {opt.leagueCode && <>, hub tag <code className="bg-muted/40 px-1 py-0.5 rounded">{opt.leagueCode}</code></>}.
              </p>
            ) : null;
          })()}
        </div>

        {/* Custom sport/hub tags — the escape hatch. Auto-filled and left
            editable when a hub above is picked, or hand-typed when "Custom"
            is selected. Left blank, nothing changes: sport defaults to
            'football' and league_code to null, same as before either of
            these fields existed. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Sport tag <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={clonedSport}
              onChange={e => { setClonedSport(e.target.value); setHubOptionId(''); }}
              placeholder="e.g. bbn"
            />
          </div>
          <div className="space-y-2">
            <Label>Hub tag <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input
              value={clonedLeagueCode}
              onChange={e => { setClonedLeagueCode(e.target.value); setHubOptionId(''); }}
              placeholder="e.g. BBN_EVICTION"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>Question</Label>
          <Textarea
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. [PL] Arsenal vs Chelsea — Match Winner"
            rows={3}
            className="resize-y"
          />
          <p className="text-xs text-muted-foreground">
            Use [PL], [CL], etc. tags for sports leagues. Press Enter for a new line — the user-facing card preserves your line breaks.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label>Options</Label>
            <Button type="button" size="sm" variant="outline" onClick={addOption} disabled={options.length >= 50} className="h-7 text-xs gap-1">
              <Plus className="w-3 h-3" /> Add option
            </Button>
          </div>
          <div className="space-y-2">
            {options.map((opt, idx) => (
              <div key={idx} className="space-y-1 rounded-md border border-border/60 px-2 py-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-medium text-muted-foreground">Option {idx + 1}</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => removeOption(idx)}
                    disabled={options.length <= 2}
                    title={options.length <= 2 ? 'Need at least 2 options' : 'Remove option'}
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-30"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </Button>
                </div>
                <Textarea
                  value={opt}
                  onChange={e => updateOption(idx, e.target.value)}
                  rows={2}
                  className="resize-y"
                  placeholder={`Option ${idx + 1}`}
                />
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(p => (
              <button
                key={p.label}
                type="button"
                onClick={() => setOptions(p.options)}
                className="text-xs px-2 py-1 bg-muted/50 rounded-md hover:bg-muted transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Closes At</Label>
            <Input type="datetime-local" value={closesAt} onChange={e => setClosesAt(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Fixture ID (sports only)</Label>
            <Input
              type="number"
              placeholder="football-data.org ID"
              value={fixtureId}
              onChange={e => setFixtureId(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2 rounded-md border border-border/60 px-3 py-2.5">
          <button
            type="button"
            onClick={() => setScheduleEnabled(v => !v)}
            className="flex items-center justify-between w-full"
          >
            <span className="flex items-center gap-2 text-sm font-medium">
              <CalendarClock className="w-4 h-4 text-muted-foreground" />
              Schedule for later
            </span>
            <span className={cn('text-xs px-2 py-0.5 rounded-full', scheduleEnabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-muted/50 text-muted-foreground')}>
              {scheduleEnabled ? 'On' : 'Off'}
            </span>
          </button>
          {scheduleEnabled && (
            <div className="space-y-1.5 pt-1">
              <Label className="text-xs">Opens At</Label>
              <Input type="datetime-local" value={opensAt} onChange={e => setOpensAt(e.target.value)} />
              <p className="text-[10px] text-muted-foreground">
                Stays hidden from every public list until this time, then opens automatically
                (checked every 5 min) and surfaces at the top of New.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label>Parent Market (optional — makes this a sub-market)</Label>
          <Select value={parentMarketId || 'none'} onValueChange={(v) => setParentMarketId(v === 'none' ? '' : v)}>
            <SelectTrigger>
              <SelectValue placeholder="Top-level market (no parent)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">— None (top-level market) —</SelectItem>
              {parentOptions.map((m) => (
                <SelectItem key={m.id} value={m.id.toString()}>
                  #{m.id}: {m.question.slice(0, 60)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[10px] text-muted-foreground">
            Sub-markets appear under their parent on the event detail page.
          </p>
        </div>

        <LockedOddsConfigBlock
          isLockedOdds={isLockedOdds}
          setIsLockedOdds={setIsLockedOdds}
          seedSize={seedSize}
          setSeedSize={setSeedSize}
          seedProbability={seedProbability}
          setSeedProbability={setSeedProbability}
          seedProbsMulti={seedProbsMulti}
          setSeedProbsMulti={setSeedProbsMulti}
          vigOverride={vigOverride}
          setVigOverride={setVigOverride}
          reserveDeployable={reserveDeployable}
          numOutcomes={numOutcomesNow}
          category={category}
        />

        <Button onClick={handleCreate} disabled={isSubmitting} className="w-full">
          {isSubmitting
            ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Creating...</>
            : isLockedOdds ? 'Create Locked-Odds Market' : 'Create Market'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Clone & Edit ──────────────────────────────────────────────────────────
//
// Fast-path for mass market creation: search any existing market by ID
// or question and prefill CreateMarketPanel's form from it (including
// its locked-odds config) so the admin only edits what's different for
// the new instance, instead of retyping the whole shape every time.
function CloneMarketPicker({ onSelect }: { onSelect: (m: any) => void }) {
  const { toast } = useToast();
  const [term, setTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<any[]>([]);

  useEffect(() => {
    const t = term.trim();
    if (!t) { setResults([]); return; }
    const h = setTimeout(async () => {
      setSearching(true);
      try {
        const asId = Number(t);
        let q = supabase
          .from('markets')
          .select('id, question, category, options, status, sport, home_team, away_team, league_code, description, parent_market_id, is_locked_odds, seed_pool, seed_probability, vig_pct')
          .order('id', { ascending: false })
          .limit(15);
        q = Number.isInteger(asId) && asId > 0 ? q.eq('id', asId) : q.ilike('question', `%${t}%`);
        const { data, error } = await q;
        if (error) throw error;
        setResults(data || []);
      } catch (err: any) {
        toast({ title: 'Clone search failed', description: err.message, variant: 'destructive' });
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(h);
  }, [term, toast]);

  return (
    <div className="space-y-2 rounded-lg border border-dashed border-muted-foreground/30 p-3">
      <Label className="flex items-center gap-2 text-xs font-medium">
        <Copy className="w-3.5 h-3.5 text-muted-foreground" />
        Clone & Edit — start from an existing market
      </Label>
      <Input
        placeholder="Search by ID or question to copy its shape + locked odds"
        value={term}
        onChange={e => setTerm(e.target.value)}
      />
      {searching ? (
        <div className="flex items-center justify-center py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
        </div>
      ) : results.length > 0 ? (
        <div className="space-y-1 max-h-48 overflow-y-auto">
          {results.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m); setTerm(''); setResults([]); }}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-muted/40 flex items-center gap-2"
            >
              <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0">#{m.id}</span>
              <Badge variant="outline" className="text-[9px] uppercase px-1 py-0 shrink-0">{m.is_locked_odds ? 'Locked' : 'Parimutuel'}</Badge>
              <span className="text-xs truncate flex-1">{m.question}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Bulk / CSV import ─────────────────────────────────────────────────────
//
// For "I already have a spreadsheet of markets" — paste rows, review/edit
// in a lightweight table (approve-before-submit, same pattern as the AI
// generator), then submit through the normal /api/admin/market endpoint.
// A shared locked-odds config (on by default) and an optional shared
// schedule apply to every approved row, same UX as the AI generator's
// bulk-submit controls.

const CSV_REQUIRED_HEADERS = ['question', 'category', 'options', 'closesat'];

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      out.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function parseMarketCsv(text: string): { rows: any[]; error: string | null } {
  const lines = text.split(/\r\n|\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { rows: [], error: 'Paste a header row plus at least one data row.' };

  const header = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  if (!CSV_REQUIRED_HEADERS.every(h => header.includes(h))) {
    return { rows: [], error: `Header row must include: question, category, options, closesAt. Got: "${lines[0]}"` };
  }

  const rows = lines.slice(1).map((line, i) => {
    const cells = parseCsvLine(line);
    const r: Record<string, string> = {};
    header.forEach((h, j) => { r[h] = cells[j] || ''; });

    const options = (r.options || '').split(';').map(o => o.trim()).filter(Boolean);
    const closesValid = !!r.closesat && !isNaN(new Date(r.closesat).getTime());
    return {
      id: `csv_${i}`,
      question: r.question || '',
      category: ['sports', 'politics', 'economics', 'entertainment', 'finance'].includes(r.category?.toLowerCase())
        ? r.category.toLowerCase() : 'sports',
      sport: r.sport || null,
      options: options.length >= 2 ? options.slice(0, 4) : ['', ''],
      closes_at: closesValid ? new Date(r.closesat).toISOString() : '',
      home_team: r.hometeam || null,
      away_team: r.awayteam || null,
      description: r.description || null,
      approved: options.length >= 2 && closesValid,
    };
  });

  return { rows, error: null };
}

function BulkImportPanel() {
  const { toast } = useToast();
  const [csvText, setCsvText] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [opensAt, setOpensAt] = useState('');
  const [lockedOddsEnabled, setLockedOddsEnabled] = useState(true);
  const [seedSize, setSeedSize] = useState('10000');
  const [vigOverride, setVigOverride] = useState('');

  const handleParse = () => {
    const { rows: parsed, error } = parseMarketCsv(csvText);
    if (error) {
      toast({ title: 'Could not parse', description: error, variant: 'destructive' });
      return;
    }
    setRows(parsed);
    const invalid = parsed.filter(r => !r.approved).length;
    toast({
      title: `${parsed.length} row(s) parsed`,
      description: invalid > 0 ? `${invalid} row(s) need a fix (bad options or close time) before they'll submit.` : 'Review, then submit.',
    });
  };

  const updateRow = (id: string, field: string, value: any) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [field]: value } : r));
  };
  const removeRow = (id: string) => setRows(prev => prev.filter(r => r.id !== id));
  const approvedCount = rows.filter(r => r.approved).length;

  const handleSubmit = async () => {
    const approved = rows.filter(r => r.approved && r.options.filter(Boolean).length >= 2 && r.closes_at);
    if (approved.length === 0) {
      toast({ title: 'No valid approved rows to submit', variant: 'destructive' });
      return;
    }
    if (scheduleEnabled && !opensAt) {
      toast({ title: 'Pick an open time, or turn scheduling off', variant: 'destructive' });
      return;
    }
    if (lockedOddsEnabled && !(Number(seedSize) > 0)) {
      toast({ title: 'Enter a valid seed size, or turn locked odds off', variant: 'destructive' });
      return;
    }
    const opensAtIso = scheduleEnabled && opensAt ? new Date(opensAt).toISOString() : null;
    setIsSubmitting(true);
    let created = 0;
    let failed = 0;
    for (const row of approved) {
      try {
        const res = await fetch('/api/admin/market', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({
            question: row.question,
            category: row.category,
            sport: row.sport,
            options: row.options.filter(Boolean),
            closesAt: row.closes_at,
            homeTeam: row.home_team,
            awayTeam: row.away_team,
            description: row.description,
            opensAt: opensAtIso,
            isLockedOdds: lockedOddsEnabled,
            seedSizeTngn: lockedOddsEnabled ? Number(seedSize) : undefined,
            seedProbability: lockedOddsEnabled && row.options.filter(Boolean).length === 2 ? 0.5 : null,
            vigPct: lockedOddsEnabled && vigOverride.trim() !== '' ? Number(vigOverride) : null,
          }),
        });
        if (res.ok) { created++; } else { failed++; }
      } catch { failed++; }
    }
    setRows(prev => prev.filter(r => !r.approved));
    toast({
      title: `${created} market${created !== 1 ? 's' : ''} ${opensAtIso ? 'scheduled' : 'created'}${failed > 0 ? `, ${failed} failed` : ''}`,
      description: opensAtIso ? `Opens automatically ${new Date(opensAtIso).toLocaleString()}.` : undefined,
    });
    setIsSubmitting(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Upload className="w-4 h-4 text-cyan-400" />
          Bulk Import (paste / CSV)
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Header row required: <code className="bg-muted/40 px-1 py-0.5 rounded text-[10px]">question,category,options,closesAt</code>{' '}
          (optional: <code className="bg-muted/40 px-1 py-0.5 rounded text-[10px]">sport,homeTeam,awayTeam,description</code>).
          Separate options with a semicolon, e.g. <code className="bg-muted/40 px-1 py-0.5 rounded text-[10px]">Home Win;Draw;Away Win</code>.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <textarea
          className="w-full h-32 bg-muted/30 border border-border rounded-lg p-3 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder={'question,category,options,closesAt\n"Will Arsenal beat Chelsea?",sports,Yes;No,2026-08-01T15:00:00Z'}
          value={csvText}
          onChange={e => setCsvText(e.target.value)}
        />
        <Button onClick={handleParse} disabled={!csvText.trim()} variant="outline" size="sm" className="gap-2">
          Parse rows
        </Button>

        {rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-border/50">
              <button
                type="button"
                onClick={() => setLockedOddsEnabled(v => !v)}
                className={cn(
                  'text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 transition-colors',
                  lockedOddsEnabled ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-border text-muted-foreground hover:bg-muted/30',
                )}
              >
                <Sparkles className="w-3 h-3" /> Locked odds for all approved
              </button>
              {lockedOddsEnabled && (
                <>
                  <Input type="number" placeholder="Seed size ₦" value={seedSize} onChange={e => setSeedSize(e.target.value)} className="h-7 text-xs w-32" />
                  <Input type="number" step="0.01" placeholder="Vig (default)" value={vigOverride} onChange={e => setVigOverride(e.target.value)} className="h-7 text-xs w-28" />
                </>
              )}
              <button
                type="button"
                onClick={() => setScheduleEnabled(v => !v)}
                className={cn(
                  'text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 transition-colors',
                  scheduleEnabled ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-border text-muted-foreground hover:bg-muted/30',
                )}
              >
                <CalendarClock className="w-3 h-3" /> Schedule all for later
              </button>
              {scheduleEnabled && (
                <Input type="datetime-local" value={opensAt} onChange={e => setOpensAt(e.target.value)} className="h-7 text-xs w-56" />
              )}
            </div>

            <div className="space-y-2 max-h-96 overflow-y-auto pr-1">
              {rows.map(row => (
                <div
                  key={row.id}
                  className={cn(
                    'border rounded-lg p-3 space-y-2',
                    row.approved ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-red-500/30 bg-red-500/5',
                  )}
                >
                  <div className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={row.approved}
                      onChange={e => updateRow(row.id, 'approved', e.target.checked)}
                      className="mt-1 w-4 h-4 cursor-pointer accent-emerald-500"
                    />
                    <input
                      type="text"
                      value={row.question}
                      onChange={e => updateRow(row.id, 'question', e.target.value)}
                      placeholder="Question"
                      className="flex-1 bg-transparent text-sm font-medium border-b border-transparent hover:border-border focus:border-primary focus:outline-none pb-0.5"
                    />
                    <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => removeRow(row.id)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid grid-cols-3 gap-2 pl-6">
                    <Input
                      value={row.options.join('; ')}
                      onChange={e => updateRow(row.id, 'options', e.target.value.split(';').map((o: string) => o.trim()).filter(Boolean))}
                      placeholder="Option A; Option B"
                      className="h-7 text-xs"
                    />
                    <Select value={row.category} onValueChange={(v) => updateRow(row.id, 'category', v)}>
                      <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="sports">Sports</SelectItem>
                        <SelectItem value="politics">Politics</SelectItem>
                        <SelectItem value="economics">Economics</SelectItem>
                        <SelectItem value="entertainment">Entertainment</SelectItem>
                        <SelectItem value="finance">Finance / Crypto</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      type="datetime-local"
                      value={row.closes_at ? row.closes_at.slice(0, 16) : ''}
                      onChange={e => updateRow(row.id, 'closes_at', e.target.value ? new Date(e.target.value).toISOString() : '')}
                      className="h-7 text-xs"
                    />
                  </div>
                  {!row.approved && (
                    <p className="text-[10px] text-red-300 pl-6">Needs 2+ options and a valid close time before it can submit.</p>
                  )}
                </div>
              ))}
            </div>

            <Button
              onClick={handleSubmit}
              disabled={isSubmitting || approvedCount === 0}
              className="w-full gap-2 bg-emerald-600 hover:bg-emerald-500"
            >
              {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Submit {approvedCount} Approved
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Locked-odds config block ─────────────────────────────────────────────
//
// Used inside CreateMarketPanel. Collapsible; defaults preserve the
// legacy parimutuel behaviour. Live opening-odds preview keeps the
// admin honest about what users will see on Day 1.
function LockedOddsConfigBlock(props: {
  isLockedOdds: boolean;
  setIsLockedOdds: (v: boolean) => void;
  seedSize: string;
  setSeedSize: (v: string) => void;
  seedProbability: string;
  setSeedProbability: (v: string) => void;
  seedProbsMulti: string[];
  setSeedProbsMulti: (v: string[] | ((prev: string[]) => string[])) => void;
  vigOverride: string;
  setVigOverride: (v: string) => void;
  reserveDeployable: number | null;
  numOutcomes: number;
  category: string;
}) {
  const {
    isLockedOdds, setIsLockedOdds,
    seedSize, setSeedSize,
    seedProbability, setSeedProbability,
    seedProbsMulti, setSeedProbsMulti,
    vigOverride, setVigOverride,
    reserveDeployable, numOutcomes, category,
  } = props;

  const seedSizeNum = Number(seedSize);
  const seedProbNum = Number(seedProbability);
  const vigNum = vigOverride.trim() === '' ? undefined : Number(vigOverride);
  const validSeed = Number.isFinite(seedSizeNum) && seedSizeNum >= 1_000 && seedSizeNum <= 14_000;
  const validVig = vigNum === undefined || (Number.isFinite(vigNum) && vigNum >= 0.04 && vigNum <= 0.15);
  const seedFitsReserve = reserveDeployable == null || seedSizeNum <= reserveDeployable;

  // Probability validation differs between the binary and multi-outcome
  // cases. Binary: single YES probability in [0.05, 0.95]. Multi: each
  // outcome in [0.02, 0.98] and they must sum to ~1.
  const multiProbs = seedProbsMulti.slice(0, numOutcomes).map(s => Number(s));
  const multiProbSum = multiProbs.reduce((a, p) => a + (Number.isFinite(p) ? p : 0), 0);
  const validMultiProbs =
    numOutcomes < 3
      ? true
      : multiProbs.length === numOutcomes
        && multiProbs.every(p => Number.isFinite(p) && p >= 0.02 && p <= 0.98)
        && Math.abs(multiProbSum - 1) <= 0.005;
  const validProb =
    numOutcomes === 2
      ? (Number.isFinite(seedProbNum) && seedProbNum >= 0.05 && seedProbNum <= 0.95)
      : validMultiProbs;

  // Compose the opening seed pool — same logic as the API but client-side.
  // For 3+ outcomes we now use the admin's per-outcome probabilities
  // instead of a blind uniform split.
  const seedPool: number[] = (() => {
    if (!validSeed || numOutcomes < 2) return [];
    if (numOutcomes === 2) {
      if (!validProb) return [];
      const yes = Math.round(seedSizeNum * seedProbNum);
      return [yes, seedSizeNum - yes];
    }
    if (validMultiProbs) {
      const raw = multiProbs.map(p => Math.round(seedSizeNum * p));
      const drift = seedSizeNum - raw.reduce((a, v) => a + v, 0);
      raw[0] += drift;
      return raw;
    }
    // Fallback while the admin is mid-edit (e.g. inputs don't sum to 1):
    // render a uniform-split preview so the panel stays informative.
    const share = Math.round(seedSizeNum / numOutcomes);
    const out = Array.from({ length: numOutcomes }, () => share);
    out[0] = seedSizeNum - share * (numOutcomes - 1);
    return out;
  })();

  // Hypothetical ₦500 opening stake on each outcome — gives the admin a
  // concrete "this is what a Day-1 user will see" number.
  const preview = isLockedOdds && seedPool.length >= 2 && validSeed && validProb
    ? seedPool.map((_, i) => {
        try {
          return calculateLockedOdds(
            { category, seedPool, realPool: Array(seedPool.length).fill(0), vigPctOverride: vigNum },
            500,
            i,
            {},
            { deployableTngn: reserveDeployable ?? 120_000, floorTngn: 30_000 },
          );
        } catch {
          return null;
        }
      })
    : null;

  return (
    <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.03] p-3 space-y-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={isLockedOdds}
          onChange={e => setIsLockedOdds(e.target.checked)}
          className="w-4 h-4 accent-emerald-500"
        />
        <span className="text-sm font-medium">Locked-odds (Pro tier)</span>
        <Badge variant="outline" className="text-[9px] border-emerald-500/30 text-emerald-300">EXPERIMENTAL</Badge>
      </label>
      <p className="text-[11px] text-muted-foreground -mt-2 ml-6">
        House-seeded market with frozen odds at stake time. Defaults preserve parimutuel.
      </p>

      {isLockedOdds && (
        <div className="space-y-3 ml-6 pt-1">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Seed size (₦)</Label>
              <Input
                type="number"
                min={1000}
                max={14000}
                value={seedSize}
                onChange={e => setSeedSize(e.target.value)}
                className={cn(!validSeed && 'border-red-500/40')}
              />
              <p className="text-[10px] text-muted-foreground">
                ₦1k – ₦14k. {reserveDeployable != null && (
                  <span className={seedFitsReserve ? 'text-emerald-400' : 'text-red-400'}>
                    Reserve: ₦{reserveDeployable.toLocaleString()} available.
                  </span>
                )}
              </p>
            </div>
            {numOutcomes === 2 && (
              <div className="space-y-1">
                <Label className="text-xs">Seed probability (YES, 0–1)</Label>
                <Input
                  type="number"
                  min={0.05}
                  max={0.95}
                  step={0.01}
                  value={seedProbability}
                  onChange={e => setSeedProbability(e.target.value)}
                  className={cn(!validProb && 'border-red-500/40')}
                />
                <p className="text-[10px] text-muted-foreground">
                  {validProb && validSeed && seedPool.length === 2 && (
                    <>Split: ₦{seedPool[0].toLocaleString()} YES · ₦{seedPool[1].toLocaleString()} NO</>
                  )}
                </p>
              </div>
            )}
          </div>

          {/* Per-outcome probability inputs for 3+ outcomes. Without
              these, the admin has no way to tilt the seed pool away
              from a uniform split (e.g. home-side favourite in 1X2).
              Inputs must sum to 1.00 — sum is surfaced below in red
              while off-target. */}
          {numOutcomes >= 3 && (
            <div className="space-y-2">
              <Label className="text-xs">Seed probability per outcome (must sum to 1.00)</Label>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {Array.from({ length: numOutcomes }).map((_, i) => (
                  <div key={i} className="space-y-1">
                    <p className="text-[10px] text-muted-foreground">Outcome {i}</p>
                    <Input
                      type="number"
                      step={0.01}
                      min={0.02}
                      max={0.98}
                      value={seedProbsMulti[i] ?? ''}
                      onChange={e => setSeedProbsMulti(prev => {
                        const next = prev.slice(0, numOutcomes);
                        while (next.length < numOutcomes) next.push('');
                        next[i] = e.target.value;
                        return next;
                      })}
                      className={cn(!validMultiProbs && 'border-red-500/40')}
                    />
                  </div>
                ))}
              </div>
              <p className={cn(
                'text-[10px]',
                Math.abs(multiProbSum - 1) > 0.005 ? 'text-red-400' : 'text-muted-foreground',
              )}>
                Sum: {multiProbSum.toFixed(3)} {Math.abs(multiProbSum - 1) > 0.005 && '— must equal 1.000'}
              </p>
              {validMultiProbs && validSeed && seedPool.length === numOutcomes && (
                <p className="text-[10px] text-muted-foreground">
                  Split: {seedPool.map((v, i) => `₦${v.toLocaleString()} (#${i})`).join(' · ')}
                </p>
              )}
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Vig override (0.04–0.15, blank = category default)</Label>
            <Input
              type="number"
              min={0.04}
              max={0.15}
              step={0.01}
              value={vigOverride}
              onChange={e => setVigOverride(e.target.value)}
              placeholder="default for category"
              className={cn(!validVig && 'border-red-500/40')}
            />
          </div>

          {/* Live opening odds preview */}
          {preview && (
            <div className="rounded-md bg-background/40 border border-border/40 p-2.5 space-y-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Opening odds — ₦500 sample</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {preview.map((r, i) => r && (
                  <div key={i} className="bg-card/40 rounded px-2 py-1.5">
                    <div className="text-[10px] text-muted-foreground">Outcome {i}</div>
                    <div className="font-bold tabular-nums">{r.lockedOdds.toFixed(2)}×</div>
                    <div className="text-[10px] text-muted-foreground">
                      ₦{r.floorPayout.toLocaleString()} – ₦{r.upperPayout.toLocaleString()}
                    </div>
                    <div className="text-[10px] text-muted-foreground">
                      vig {(r.vigApplied * 100).toFixed(1)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!seedFitsReserve && (
            <p className="text-[11px] text-red-400">
              Seed exceeds deployable reserve. Reduce seed size or settle a market first.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Manual Override Panel ─────────────────────────────────────────────────
function ManualOverridePanel() {
  const { toast } = useToast();
  const [lockMarketId, setLockMarketId] = useState('');
  const [unlockMarketId, setUnlockMarketId] = useState('');
  const [unlockClosesAtLocal, setUnlockClosesAtLocal] = useState('');
  const [resolveMarketId, setResolveMarketId] = useState('');
  const [winningOutcome, setWinningOutcome] = useState('');
  const [isLocking, setIsLocking] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isFiringHeartbeat, setIsFiringHeartbeat] = useState(false);
  const [markets, setMarkets] = useState<any[]>([]);
  const [marketsLoadError, setMarketsLoadError] = useState<string | null>(null);
  const [selectedMarket, setSelectedMarket] = useState<any>(null);
  // Manual fallback — Force Lock is an escape hatch for exactly the case
  // where automation has already broken down, so it can't be entirely
  // dependent on this dropdown being populated. If the fetch below fails
  // silently (RLS edge case, network hiccup) or there simply are zero
  // 'open' markets to show, the admin can still type an ID directly.
  const [manualLockMarketId, setManualLockMarketId] = useState('');

  useEffect(() => {
    supabase
      .from('markets')
      .select('id, question, options, status, closes_at')
      .in('status', ['open', 'locked'])
      .order('closes_at', { ascending: true })
      .limit(30)
      .then(({ data, error }) => {
        if (error) {
          console.error('ManualOverridePanel: failed to load markets:', error);
          setMarketsLoadError(error.message);
          return;
        }
        setMarketsLoadError(null);
        setMarkets(data || []);
      });
  }, []);

  useEffect(() => {
    if (resolveMarketId) {
      const m = markets.find(m => m.id.toString() === resolveMarketId);
      setSelectedMarket(m || null);
    }
  }, [resolveMarketId, markets]);

  const forceLock = async () => {
    // Manual ID input wins if filled in — it's the fallback for when the
    // dropdown has nothing to select (see manualLockMarketId above).
    const targetId = manualLockMarketId.trim() || lockMarketId;
    if (!targetId) return;
    setIsLocking(true);
    try {
      const res = await fetch('/api/markets/lock', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ marketId: parseInt(targetId) }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      toast({ title: `Market ${targetId} locked! ${data.betCount} bets committed.` });
      setLockMarketId('');
      setManualLockMarketId('');
    } catch (err: any) {
      toast({ title: 'Lock failed', description: err.message, variant: 'destructive' });
    } finally { setIsLocking(false); }
  };

  const forceUnlock = async () => {
    if (!unlockMarketId || !unlockClosesAtLocal) return;
    const newClosesAt = new Date(unlockClosesAtLocal);
    if (Number.isNaN(newClosesAt.getTime())) {
      toast({ title: 'Unlock failed', description: 'Invalid close time', variant: 'destructive' });
      return;
    }
    setIsUnlocking(true);
    try {
      const res = await fetch(`/api/admin/markets/${unlockMarketId}/unlock`, {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ closesAt: newClosesAt.toISOString() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      toast({ title: `Market ${unlockMarketId} unlocked!`, description: `Reopened for betting, closes ${newClosesAt.toLocaleString()}.` });
      setUnlockMarketId('');
      setUnlockClosesAtLocal('');
      setMarkets(prev => prev.map(m => m.id === data.market.id ? { ...m, status: 'open', closes_at: data.market.closes_at } : m));
    } catch (err: any) {
      toast({ title: 'Unlock failed', description: err.message, variant: 'destructive' });
    } finally { setIsUnlocking(false); }
  };

  const forceResolve = async () => {
    if (!resolveMarketId || winningOutcome === '') return;
    setIsResolving(true);
    try {
      const res = await fetch('/api/markets/resolve', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          marketId: parseInt(resolveMarketId),
          winningOutcomeIndex: parseInt(winningOutcome),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      if (data.partial) {
        toast({
          title: `Market ${resolveMarketId} only partially resolved`,
          description: `${data.failedBetIds?.length ?? 0} bet(s) failed to settle and are still active — re-resolve to retry.`,
          variant: 'destructive',
        });
      } else {
        toast({ title: `Market ${resolveMarketId} resolved! ${data.winnersCount ?? 0} winner(s) paid.` });
      }
      setResolveMarketId('');
      setWinningOutcome('');
      setSelectedMarket(null);
    } catch (err: any) {
      toast({ title: 'Resolve failed', description: err.message, variant: 'destructive' });
    } finally { setIsResolving(false); }
  };

  const fireHeartbeat = async () => {
    setIsFiringHeartbeat(true);
    try {
      const res = await fetch('/api/admin/heartbeat', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      toast({ title: '❤️ Heartbeat fired! Escape hatch clock reset.' });
    } catch (err: any) {
      toast({ title: 'Heartbeat failed', description: err.message, variant: 'destructive' });
    } finally { setIsFiringHeartbeat(false); }
  };

  return (
    <div className="space-y-4">
      {/* Force Lock */}
      <Card className="border-amber-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-400" />
            Force Lock Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Use when the cron job missed the kickoff. Computes Merkle root and seals the prediction ledger.</p>
          {marketsLoadError && (
            <p className="text-xs text-red-400">
              Couldn&apos;t load the market list ({marketsLoadError}) — use the market ID field below instead.
            </p>
          )}
          <div className="flex gap-2">
            <Select value={lockMarketId} onValueChange={(v) => { setLockMarketId(v); setManualLockMarketId(''); }}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={markets.filter(m => m.status === 'open').length === 0 ? 'No open markets found' : 'Select market...'} />
              </SelectTrigger>
              <SelectContent>
                {markets.filter(m => m.status === 'open').map(m => (
                  <SelectItem key={m.id} value={m.id.toString()}>
                    {m.id}: {m.question.slice(0, 50)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={forceLock} disabled={(!lockMarketId && !manualLockMarketId.trim()) || isLocking} variant="outline" className="border-amber-500/30">
              {isLocking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground shrink-0">or by ID</span>
            <Input
              type="number"
              placeholder="Market ID (works even if the dropdown is empty)"
              value={manualLockMarketId}
              onChange={(e) => { setManualLockMarketId(e.target.value); if (e.target.value) setLockMarketId(''); }}
              className="h-8 text-xs"
            />
          </div>
        </CardContent>
      </Card>

      {/* Unlock Market */}
      <Card className="border-cyan-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Unlock className="w-4 h-4 text-cyan-400" />
            Unlock Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Use when a market locked too early (stale closes_at, accidental force-lock). Reopens it for betting and
            requires a new close time so it doesn&rsquo;t immediately look overdue again. Clears the on-chain seal —
            locking it again later commits a fresh Merkle root.
          </p>
          <Select value={unlockMarketId} onValueChange={setUnlockMarketId}>
            <SelectTrigger>
              <SelectValue placeholder="Select locked market..." />
            </SelectTrigger>
            <SelectContent>
              {markets.filter(m => m.status === 'locked').map(m => (
                <SelectItem key={m.id} value={m.id.toString()}>
                  {m.id}: {m.question.slice(0, 50)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="space-y-1">
            <Label className="text-xs">New close time</Label>
            <Input
              type="datetime-local"
              value={unlockClosesAtLocal}
              onChange={(e) => setUnlockClosesAtLocal(e.target.value)}
            />
          </div>
          <Button
            onClick={forceUnlock}
            disabled={!unlockMarketId || !unlockClosesAtLocal || isUnlocking}
            className="w-full bg-cyan-600 hover:bg-cyan-500"
          >
            {isUnlocking ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Unlocking...</> : 'Unlock & Reschedule'}
          </Button>
        </CardContent>
      </Card>

      {/* Force Resolve */}
      <Card className="border-emerald-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Force Resolve Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Select any market — open markets will be locked automatically before resolution.</p>
          <Select value={resolveMarketId} onValueChange={setResolveMarketId}>
            <SelectTrigger>
              <SelectValue placeholder="Select market to resolve..." />
            </SelectTrigger>
            <SelectContent>
              {markets.map(m => (
                <SelectItem key={m.id} value={m.id.toString()}>
                  {m.id}: {m.question.slice(0, 50)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedMarket && (
            <Select value={winningOutcome} onValueChange={setWinningOutcome}>
              <SelectTrigger>
                <SelectValue placeholder="Select winning outcome..." />
              </SelectTrigger>
              <SelectContent>
                {(selectedMarket.options as string[]).map((opt: string, i: number) => (
                  <SelectItem key={i} value={i.toString()}>
                    {i}: {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            onClick={forceResolve}
            disabled={!resolveMarketId || winningOutcome === '' || isResolving}
            className="w-full bg-emerald-600 hover:bg-emerald-500"
          >
            {isResolving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resolving...</> : 'Resolve & Pay Winners'}
          </Button>
        </CardContent>
      </Card>

      {/* Heartbeat */}
      <Card className="border-blue-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            Emergency Heartbeat
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Resets the 30-day escape hatch clock. Fire immediately if the weekly cron job missed a run.
          </p>
          <Button
            onClick={fireHeartbeat}
            disabled={isFiringHeartbeat}
            variant="outline"
            className="w-full border-blue-500/30"
          >
            {isFiringHeartbeat ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Firing...</> : '❤️ Fire Heartbeat Now'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Withdrawal Approvals ──────────────────────────────────────────────────
type Withdrawal = {
  id: string;
  user_id: string;
  amount_tngn: number;
  naira_to_send: number;
  bank_code: string;
  account_number: string;
  created_at?: string;
  users?: { email?: string };
};

type TreasuryData = {
  liveBalances: { paystack: number | null; squad: number | null; errors: Record<string, string> };
  ledger: Record<'paystack' | 'squad' | 'unallocated', { in: number; out: number; net: number }>;
  pendingWithdrawals: Array<{
    id: string;
    user_id: string;
    amount_tngn: number;
    naira_to_send: number;
    bank_code: string;
    account_number: string;
    account_name: string | null;
    status: string;
    gateway: string | null;
    created_at: string;
    user: { email?: string; username?: string } | null;
  }>;
};

// ── Void Panel — pending void queue + manual force-void by search ─────
//
// Two workflows in one tab. Top card shows every market resolve tried
// to void because it looked empty (no user_bets found) — with
// corroborating checks (treasury/tier-routing rows written in the SAME
// tx as a bet, duplicate market-question rows) so we DON'T approve a
// void on a market whose bets were placed somewhere else.
//
// Bottom card is a live search — pick any market by ID/question and
// force-void it explicitly. This refunds every active single bet on
// the market proportional to how it was funded (cash back to cash,
// bonus back to bonus), voids every active multiplier leg on it so
// parent slips advance, and is logged to treasury_log as
// admin_force_void.
function VoidPanel() {
  const { toast } = useToast();
  const [pending, setPending] = useState<any[]>([]);
  const [pendingLoading, setPendingLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Search state — text input, list of matches, selected market.
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<any>(null);
  const [voidReason, setVoidReason] = useState('');
  const [confirmForceVoid, setConfirmForceVoid] = useState(false);
  const [isVoiding, setIsVoiding] = useState(false);

  const loadPending = useCallback(async () => {
    setPendingLoading(true);
    try {
      const res = await fetch(`/api/admin/void-queue?_=${Date.now()}`, {
        headers: adminHeaders(),
        credentials: 'include',
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPending(data.entries || []);
    } catch (err: any) {
      toast({ title: 'Failed to load void queue', description: err.message, variant: 'destructive' });
    } finally {
      setPendingLoading(false);
    }
  }, [toast]);

  useEffect(() => { loadPending(); }, [loadPending]);

  const [batchBusy, setBatchBusy] = useState(false);

  const decide = async (marketId: number, action: 'approve' | 'reject') => {
    setBusyId(marketId);
    try {
      const res = await fetch('/api/admin/void-queue', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ marketId, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({
        title: action === 'approve' ? `Market ${marketId} voided` : `Market ${marketId} sent back to locked`,
        description: action === 'reject' ? 'Investigate before re-resolving.' : undefined,
      });
      loadPending();
    } catch (err: any) {
      toast({ title: 'Void queue action failed', description: err.message, variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  };

  const batchDecide = async (marketIds: number[], action: 'approve' | 'reject') => {
    if (marketIds.length === 0) return;
    setBatchBusy(true);
    try {
      const res = await fetch('/api/admin/void-queue', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({ marketIds, action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      const updatedCount = (data.updated || []).length;
      toast({
        title: action === 'approve' ? `${updatedCount} market(s) voided` : `${updatedCount} market(s) sent back to locked`,
        description: (data.notEligible || []).length > 0
          ? `${data.notEligible.length} skipped — no longer pending_void.`
          : (action === 'reject' ? 'Investigate before re-resolving.' : undefined),
      });
      loadPending();
    } catch (err: any) {
      toast({ title: 'Batch void action failed', description: err.message, variant: 'destructive' });
    } finally {
      setBatchBusy(false);
    }
  };

  // ── Manual search ──────────────────────────────────────────────────
  const runSearch = useCallback(async (term: string) => {
    const t = term.trim();
    if (!t) { setSearchResults([]); return; }
    setSearching(true);
    try {
      // Numeric term → id lookup; otherwise ilike search on question.
      const asId = Number(t);
      let q = supabase.from('markets')
        .select('id, question, status, closes_at, options, resolved_outcome, is_locked_odds')
        .order('closes_at', { ascending: false })
        .limit(20);
      q = Number.isInteger(asId) && asId > 0
        ? q.eq('id', asId)
        : q.ilike('question', `%${t}%`);
      const { data, error } = await q;
      if (error) throw error;
      setSearchResults(data || []);
    } catch (err: any) {
      toast({ title: 'Search failed', description: err.message, variant: 'destructive' });
    } finally {
      setSearching(false);
    }
  }, [toast]);

  // Debounced search on every keystroke.
  useEffect(() => {
    const h = setTimeout(() => runSearch(searchTerm), 250);
    return () => clearTimeout(h);
  }, [searchTerm, runSearch]);

  const doForceVoid = async () => {
    if (!selectedMarket) return;
    setIsVoiding(true);
    try {
      const res = await fetch('/api/admin/void-queue', {
        method: 'POST',
        headers: adminHeaders(),
        credentials: 'include',
        body: JSON.stringify({
          marketId: selectedMarket.id,
          action: 'force_void',
          reason: voidReason.trim() || null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      toast({
        title: `Market ${selectedMarket.id} force-voided`,
        description: `${data.betsRefunded ?? 0} bet(s) refunded (₦${Math.round(data.totalRefundTngn || 0).toLocaleString()}).`,
      });
      setSelectedMarket(null);
      setSearchTerm('');
      setSearchResults([]);
      setVoidReason('');
      setConfirmForceVoid(false);
      loadPending();
    } catch (err: any) {
      toast({ title: 'Force-void failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsVoiding(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Pending queue */}
      <Card className="border-amber-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400" />
              Pending Void Queue ({pending.length})
            </span>
            <Button size="sm" variant="ghost" onClick={loadPending} disabled={pendingLoading}>
              {pendingLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Refresh'}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-3">
            Markets resolve wanted to auto-void because they looked empty. Each entry shows
            corroborating checks so you can catch a wrongful void before approving. Red flags
            below mean bets probably existed — <strong>investigate before approving.</strong>
          </p>

          {pendingLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <DataTable
              rows={pending}
              rowKey={(e) => e.marketId}
              searchFields={(e) => `${e.marketId} ${e.question}`}
              pageSize={15}
              emptyMessage="Queue is empty."
              bulkActions={[
                {
                  label: 'Approve void (selected)',
                  variant: 'destructive',
                  disabled: () => batchBusy,
                  onClick: (rows) => batchDecide(rows.map(r => r.marketId), 'approve'),
                },
                {
                  label: 'Back to locked (selected)',
                  variant: 'outline',
                  disabled: () => batchBusy,
                  onClick: (rows) => batchDecide(rows.map(r => r.marketId), 'reject'),
                },
              ]}
              columns={[
                {
                  key: 'market',
                  label: 'Market',
                  className: 'min-w-[240px] max-w-sm',
                  render: (e) => (
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-mono text-muted-foreground">#{e.marketId}</span>
                        <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">{e.isLockedOdds ? 'Locked' : 'Parimutuel'}</Badge>
                        {e.suspicious && (
                          <Badge className="bg-red-500/20 text-red-300 border-red-500/30 text-[9px] uppercase px-1 py-0">Suspicious</Badge>
                        )}
                      </div>
                      <p className="text-xs font-medium leading-snug line-clamp-2">{e.question}</p>
                    </div>
                  ),
                },
                {
                  key: 'signals',
                  label: 'Signals',
                  className: 'min-w-[220px]',
                  render: (e) => (
                    <div className="space-y-1.5">
                      <div className="grid grid-cols-4 gap-1 text-[10px]">
                        <Stat label="Bets" value={e.totalBetRows} />
                        <Stat label="Legs" value={e.activeLegs} />
                        <Stat label="Rake rows" value={e.corroboratingTreasuryRows} highlight={e.corroboratingTreasuryRows > 0} />
                        <Stat label="Dupes" value={(e.duplicateMarketIds || []).length} highlight={(e.duplicateMarketIds || []).length > 0} />
                      </div>
                      <p className={cn('text-[10px] italic', e.suspicious ? 'text-red-300' : 'text-muted-foreground')}>
                        {e.recommendation}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  label: 'Actions',
                  className: 'w-40',
                  render: (e) => (
                    <div className="flex flex-col items-start gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-red-500/30 text-red-300 hover:bg-red-500/10 w-full justify-start"
                        disabled={busyId === e.marketId || batchBusy}
                        onClick={() => decide(e.marketId, 'approve')}
                      >
                        {busyId === e.marketId ? <Loader2 className="w-3 h-3 animate-spin" /> : <><Ban className="w-3 h-3 mr-1" />Approve void</>}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs w-full justify-start"
                        disabled={busyId === e.marketId || batchBusy}
                        onClick={() => decide(e.marketId, 'reject')}
                      >
                        <Unlock className="w-3 h-3 mr-1" />Back to locked
                      </Button>
                    </div>
                  ),
                },
              ]}
            />
          )}
        </CardContent>
      </Card>

      {/* Manual force-void */}
      <Card className="border-red-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Search className="w-4 h-4 text-red-400" />
            Search &amp; Force-Void
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Find any market by ID or question, then explicitly void it. Refunds every active
            single bet on it proportional to its funding (cash back to cash, bonus back to bonus),
            voids every active multiplier leg so parent slips can advance. Won&#39;t touch
            already-settled bets — for those, use <code className="bg-muted/40 px-1 py-0.5 rounded text-[10px]">/api/admin/re-resolve-voided-market</code>.
          </p>

          <div className="space-y-2">
            <Label>Search (market ID or text)</Label>
            <Input
              placeholder="e.g. 1856 or “Erling Haaland”"
              value={searchTerm}
              onChange={(e) => { setSearchTerm(e.target.value); setSelectedMarket(null); }}
            />
          </div>

          {searching ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
            </div>
          ) : searchResults.length > 0 && !selectedMarket ? (
            <div className="space-y-1 max-h-64 overflow-y-auto border border-muted rounded-lg p-1">
              {searchResults.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setSelectedMarket(m)}
                  className="w-full text-left px-2 py-2 rounded hover:bg-muted/40 flex items-center gap-2"
                >
                  <span className="text-[10px] font-mono text-muted-foreground w-12 shrink-0">#{m.id}</span>
                  <Badge variant="outline" className="text-[9px] uppercase px-1 py-0 shrink-0">{m.status}</Badge>
                  <span className="text-xs truncate flex-1">{m.question}</span>
                </button>
              ))}
            </div>
          ) : null}

          {selectedMarket && (
            <div className="border border-red-500/30 rounded-lg p-3 space-y-3 bg-red-500/5">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Selected</p>
                <p className="text-xs font-medium">#{selectedMarket.id} — {selectedMarket.question}</p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Status: <strong>{selectedMarket.status}</strong> · Closes {new Date(selectedMarket.closes_at).toLocaleString()}
                </p>
              </div>

              {(selectedMarket.status === 'voided' || selectedMarket.status === 'resolved') && (
                <p className="text-xs text-amber-300 flex items-center gap-2">
                  <AlertTriangle className="w-3 h-3" />
                  Already {selectedMarket.status} — force-void is only for pre-settlement voiding.
                </p>
              )}

              <div className="space-y-2">
                <Label>Reason (optional, stored on treasury_log)</Label>
                <Input
                  placeholder="Fixture cancelled, corrupted data, etc."
                  value={voidReason}
                  onChange={(e) => setVoidReason(e.target.value)}
                />
              </div>

              <label className="flex items-start gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={confirmForceVoid}
                  onChange={(e) => setConfirmForceVoid(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I confirm this will refund every active bet and void every active leg on market
                  #{selectedMarket.id}. This is irreversible without a manual re-resolve.
                </span>
              </label>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => { setSelectedMarket(null); setConfirmForceVoid(false); setVoidReason(''); }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-8 bg-red-600 hover:bg-red-500 gap-2"
                  disabled={!confirmForceVoid || isVoiding || selectedMarket.status === 'voided' || selectedMarket.status === 'resolved'}
                  onClick={doForceVoid}
                >
                  {isVoiding ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                  Force void
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: number | string; highlight?: boolean }) {
  return (
    <div className={cn(
      'bg-muted/20 rounded p-1.5 text-center',
      highlight && 'bg-red-500/10',
    )}>
      <p className="text-[9px] uppercase text-muted-foreground">{label}</p>
      <p className={cn('text-xs font-semibold tabular-nums', highlight && 'text-red-300')}>{value}</p>
    </div>
  );
}

function WithdrawalPanel() {
  const { toast } = useToast();
  const [data, setData] = useState<TreasuryData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [rejectTargetId, setRejectTargetId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [busyRowId, setBusyRowId] = useState<string | null>(null);
  const [isRefunding, setIsRefunding] = useState(false);
  const [manualTarget, setManualTarget] = useState<TreasuryData['pendingWithdrawals'][number] | null>(null);
  const [manualPaidFrom, setManualPaidFrom] = useState('');
  const [manualReference, setManualReference] = useState('');
  const [isMarkingPaid, setIsMarkingPaid] = useState(false);
  const prevPendingCountRef = useRef<number>(0);

  const fetchData = useCallback(async () => {
    const res = await fetch('/api/admin/treasury', { headers: adminHeaders() });
    const body = await res.json();
    if (res.ok) {
      setData(body);
      // Audible ping when a NEW pending withdrawal shows up since last poll —
      // lets the operator stay in another tab and still catch incoming requests.
      const count = body.pendingWithdrawals?.length || 0;
      if (count > prevPendingCountRef.current && prevPendingCountRef.current > 0) {
        try {
          const audio = new Audio('data:audio/wav;base64,UklGRpYAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YXIAAAB/f39/f39/f3+AhYqOj42IhH13c3R5goeKi4qFf3p4eXyAhIaGhYJ/fHt7fH+ChIWFg4F/fn1+f4GDhIODgYB/f3+AgYKCgoGAgIB/f4CAgYGBgYCAgIB/f4CAgIGBgYGAgIB/f4CAgIGBgYGAgIB/');
          audio.volume = 0.3;
          audio.play().catch(() => {});
        } catch {}
      }
      prevPendingCountRef.current = count;
    }
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
    // Deliberately NOT visibility-gated: the audible ping above is the
    // whole reason this panel polls — the operator stays on another tab
    // and relies on it to catch new withdrawals. Interval bumped 30s→60s
    // to cut IO load roughly in half while preserving that behaviour.
    const t = setInterval(fetchData, 60_000);
    return () => clearInterval(t);
  }, [fetchData]);

  const approveVia = async (withdrawalId: string, gateway: 'paystack' | 'squad') => {
    setBusyRowId(withdrawalId);
    try {
      const res = await fetch('/api/admin/withdrawals/approve', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ withdrawalId, gateway }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Approval failed');
      toast({ title: `Payout fired via ${gateway === 'paystack' ? 'Paystack' : 'Squad'}` });
      fetchData();
    } catch (e: any) {
      toast({ title: 'Payout failed', description: e.message, variant: 'destructive' });
    } finally {
      setBusyRowId(null);
    }
  };

  const submitManualPaid = async () => {
    if (!manualTarget) return;
    if (!manualPaidFrom.trim() || !manualReference.trim()) {
      toast({ title: 'Both fields are required', variant: 'destructive' });
      return;
    }
    setIsMarkingPaid(true);
    try {
      const res = await fetch('/api/admin/withdrawals/approve', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          withdrawalId: manualTarget.id,
          gateway: 'manual',
          manualPaidFrom: manualPaidFrom.trim(),
          manualReference: manualReference.trim(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Failed to record payout');
      toast({
        title: 'Payout recorded',
        description: `₦${manualTarget.naira_to_send.toLocaleString()} from ${manualPaidFrom.trim()} · ref ${manualReference.trim()}`,
      });
      setManualTarget(null);
      setManualPaidFrom('');
      setManualReference('');
      fetchData();
    } catch (e: any) {
      toast({ title: 'Could not record payout', description: e.message, variant: 'destructive' });
    } finally {
      setIsMarkingPaid(false);
    }
  };

  const submitReject = async () => {
    if (!rejectTargetId) return;
    setIsRefunding(true);
    try {
      const res = await fetch('/api/admin/withdrawals/reject', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ withdrawalId: rejectTargetId, reason: rejectReason.trim() || 'Rejected by admin' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Reject failed');
      toast({ title: 'Withdrawal rejected', description: 'User refunded.' });
      setRejectTargetId(null);
      setRejectReason('');
      fetchData();
    } catch (e: any) {
      toast({ title: 'Reject failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsRefunding(false);
    }
  };

  if (isLoading) return <div className="h-32 bg-muted/30 rounded-xl animate-pulse" />;
  if (!data) return <div className="text-sm text-muted-foreground">Failed to load treasury data.</div>;

  const fmt = (n: number | null) => n == null ? '—' : `₦${Math.round(n).toLocaleString()}`;

  return (
    <>
      {/* ── Live Treasury Balances ───────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        {(['paystack', 'squad'] as const).map(g => {
          const live = data.liveBalances[g];
          const led = data.ledger[g];
          const drift = live != null ? live - led.net : null;
          return (
            <Card key={g} className="bg-card/60">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold capitalize">{g}</span>
                  {data.liveBalances.errors[g] && (
                    <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">live unavailable</Badge>
                  )}
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Available to pay out</div>
                  <div className="text-2xl font-bold">{fmt(live)}</div>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[11px] pt-2 border-t border-border/40">
                  <div><div className="text-muted-foreground">Inflow</div><div className="text-emerald-400 font-medium">{fmt(led.in)}</div></div>
                  <div><div className="text-muted-foreground">Outflow</div><div className="text-rose-400 font-medium">{fmt(led.out)}</div></div>
                  <div><div className="text-muted-foreground">Ledger net</div><div className="font-medium">{fmt(led.net)}</div></div>
                </div>
                {drift != null && Math.abs(drift) > 1 && (
                  <div className="text-[10px] text-amber-400/80">
                    Drift: {drift > 0 ? '+' : ''}{fmt(drift)} (live vs ledger — investigate)
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* ── Pending Withdrawals Queue ──────────────────────────────── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center justify-between">
            Pending Withdrawals
            <Badge variant="outline">{data.pendingWithdrawals.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {data.pendingWithdrawals.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">No pending withdrawals 🎉</div>
          ) : (
            data.pendingWithdrawals.map(w => {
              const live = data.liveBalances;
              const canPaystack = live.paystack == null || live.paystack >= w.naira_to_send;
              const canSquad = live.squad == null || live.squad >= w.naira_to_send;
              const isBusy = busyRowId === w.id;
              return (
                <div key={w.id} className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-3">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {w.user?.email || w.user?.username || `${w.user_id.slice(0, 8)}…`}
                        </span>
                        <span className="text-lg font-bold">₦{w.naira_to_send.toLocaleString()}</span>
                        <span className="text-[10px] text-muted-foreground">
                          (from {w.amount_tngn.toLocaleString()} tNGN)
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {findBankByCode(w.bank_code)?.name || `Bank ${w.bank_code}`} · NUBAN {w.account_number}
                        {w.account_name && <> · {w.account_name}</>}
                      </div>
                      <div className="text-[10px] text-muted-foreground">
                        Requested {new Date(w.created_at).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {/* Squad payout API not yet activated by HabariPay — we're
                          on manual mode: send the money from your own bank, then
                          record the bank-reference here for the audit trail. */}
                      <Button
                        size="sm"
                        className="h-8 text-xs bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50"
                        onClick={() => {
                          setManualTarget(w);
                          setManualPaidFrom('');
                          setManualReference('');
                        }}
                        disabled={isBusy}
                        title="I've already sent the money — record the bank reference"
                      >
                        Mark as Paid
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 text-xs border-red-500/30 text-red-400"
                        onClick={() => setRejectTargetId(w.id)}
                        disabled={isBusy}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <WithdrawalHistoryPanel />

      <Dialog
        open={!!manualTarget}
        onOpenChange={(open) => {
          if (!open) {
            setManualTarget(null);
            setManualPaidFrom('');
            setManualReference('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record manual payout</DialogTitle>
            <DialogDescription>
              Send the money from your own bank first, then enter the details
              below. We&apos;ll mark the withdrawal completed and stamp the ledger
              with this reference so you can reconcile against your bank
              statement later.
            </DialogDescription>
          </DialogHeader>
          {manualTarget && (
            <div className="rounded-lg border border-border/50 bg-muted/30 p-3 text-xs space-y-1 mb-2">
              <div className="flex justify-between"><span className="text-muted-foreground">Send to user</span><span className="font-medium">{manualTarget.user?.email || manualTarget.user_id.slice(0, 8)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Amount</span><span className="font-bold text-emerald-400">₦{manualTarget.naira_to_send.toLocaleString()}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Bank</span><span>{findBankByCode(manualTarget.bank_code)?.name || `Bank ${manualTarget.bank_code}`}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">NUBAN</span><span className="font-mono">{manualTarget.account_number}</span></div>
              {manualTarget.account_name && (
                <div className="flex justify-between"><span className="text-muted-foreground">Account name</span><span>{manualTarget.account_name}</span></div>
              )}
            </div>
          )}
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Paid from which of my banks?</Label>
              <Input
                placeholder="e.g. GTBank Opinions Ltd, UBA personal"
                value={manualPaidFrom}
                onChange={(e) => setManualPaidFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Bank transaction reference</Label>
              <Input
                placeholder="The session/transfer ID from your bank app"
                value={manualReference}
                onChange={(e) => setManualReference(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">
                Use the reference from the success screen in your bank app — makes statement reconciliation trivial.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualTarget(null)} disabled={isMarkingPaid}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-500"
              onClick={submitManualPaid}
              disabled={isMarkingPaid || !manualPaidFrom.trim() || !manualReference.trim()}
            >
              {isMarkingPaid ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Recording…</> : 'Record payout'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectTargetId} onOpenChange={(open) => { if (!open) { setRejectTargetId(null); setRejectReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject withdrawal</DialogTitle>
            <DialogDescription>
              Balance will be refunded to the user&apos;s tNGN wallet. The reason is sent to their notification feed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>Reason (optional)</Label>
            <Input
              placeholder="e.g. Account name mismatch"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTargetId(null)} disabled={isRefunding}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={submitReject} disabled={isRefunding}>
              {isRefunding ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Refunding…</> : 'Confirm reject'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Withdrawal History (full ledger — every status, for tracking/audit) ───
type WithdrawalHistoryRow = {
  id: string;
  user_id: string;
  amount_tngn: number;
  naira_to_send: number;
  bank_code: string;
  account_number: string;
  account_name: string | null;
  status: string;
  gateway: string | null;
  gateway_transfer_code: string | null;
  admin_note: string | null;
  manual_paid_from: string | null;
  manual_reference: string | null;
  created_at: string;
  approved_at: string | null;
  processed_at: string | null;
  user: { email?: string; username?: string } | null;
};

const WITHDRAWAL_STATUS_STYLES: Record<string, string> = {
  pending_admin_approval: 'border-amber-500/40 text-amber-400',
  transfer_initiated: 'border-blue-500/40 text-blue-400',
  completed: 'border-emerald-500/40 text-emerald-400',
  failed_transfer: 'border-red-500/40 text-red-400',
  rejected: 'border-red-500/40 text-red-400',
};

function WithdrawalHistoryPanel() {
  const [rows, setRows] = useState<WithdrawalHistoryRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/withdrawals/history', { headers: adminHeaders() });
      const body = await res.json();
      if (res.ok) setRows(body.withdrawals || []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const statuses = ['all', ...Array.from(new Set(rows.map(r => r.status)))];
  const filtered = statusFilter === 'all' ? rows : rows.filter(r => r.status === statusFilter);
  const bankName = (code: string) => findBankByCode(code)?.name || code;

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between flex-wrap gap-2">
          <span className="flex items-center gap-2">
            Withdrawal History
            <Badge variant="outline">{filtered.length}</Badge>
          </span>
          <div className="flex items-center gap-2">
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 w-[180px] text-xs">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                {statuses.map(s => (
                  <SelectItem key={s} value={s} className="text-xs">
                    {s === 'all' ? 'All statuses' : s.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={load} className="h-8 text-xs text-muted-foreground">
              Refresh
            </Button>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoading ? (
          <div className="h-24 bg-muted/30 rounded-xl animate-pulse" />
        ) : filtered.length === 0 ? (
          <div className="text-sm text-muted-foreground py-6 text-center">No withdrawals match this filter.</div>
        ) : (
          <div className="space-y-1.5 max-h-[420px] overflow-y-auto pr-1">
            {filtered.map(w => (
              <div key={w.id} className="rounded-lg border border-border/40 bg-muted/10 px-3 py-2 text-xs flex items-start justify-between gap-3 flex-wrap">
                <div className="min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{w.user?.email || w.user?.username || `${w.user_id.slice(0, 8)}…`}</span>
                    <span className="font-bold">₦{Number(w.naira_to_send || 0).toLocaleString()}</span>
                    <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0', WITHDRAWAL_STATUS_STYLES[w.status] || 'border-muted-foreground/30 text-muted-foreground')}>
                      {w.status.replace(/_/g, ' ')}
                    </Badge>
                    {w.gateway && <Badge variant="outline" className="text-[9px] px-1.5 py-0 capitalize">{w.gateway}</Badge>}
                  </div>
                  <div className="text-muted-foreground">
                    {bankName(w.bank_code)} · {w.account_number}{w.account_name && ` · ${w.account_name}`}
                  </div>
                  {w.gateway_transfer_code && (
                    <div className="text-[10px] text-muted-foreground/70 font-mono">ref: {w.gateway_transfer_code}</div>
                  )}
                  {w.manual_paid_from && (
                    <div className="text-[10px] text-emerald-300/80">paid from: {w.manual_paid_from}</div>
                  )}
                  {w.admin_note && (
                    <div className="text-[10px] text-amber-400/80">note: {w.admin_note}</div>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground text-right shrink-0">
                  <div>{new Date(w.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
                  {w.processed_at && <div>processed {new Date(w.processed_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Users (per-user credits monitor) ──────────────────────────────────────
type UserRow = {
  id: string;
  email: string | null;
  username: string | null;
  tngn_balance: number;
  bonus_balance: number;
  bonus_expires_at: string | null;
  lifetime_credits: number;
  created_at: string | null;
  last_active_at: string | null;
};

function UsersPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'last_active', dir: 'desc' });
  const [isLoading, setIsLoading] = useState(true);
  const [issueTarget, setIssueTarget] = useState<UserRow | null>(null);
  const [issueAmount, setIssueAmount] = useState('');
  const [issueReason, setIssueReason] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);
  // The user_id whose forensic drawer is currently open. Null = nothing
  // selected (drawer closed). UserDetailDrawer self-fetches on change.
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setIsLoading(true);
    const params = new URLSearchParams({
      search,
      sort: sort.key,
      dir: sort.dir,
      page: String(page),
      pageSize: String(pageSize),
    });
    const res = await fetch(`/api/admin/users?${params.toString()}`);
    const data = await res.json();
    setRows(data.users || []);
    setTotal(data.total || 0);
    setIsLoading(false);
  }, [search, sort, page]);

  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    // Both bonus columns, not just one. bonus_balance_spendable matches what
    // the Bonus column on screen shows (and what the user's own dashboard
    // shows); bonus_balance_raw is the underlying ledger figure, which a
    // reconciliation still legitimately needs. Picking only one would make
    // this export wrong for whichever use it was not picked for.
    const header = ['id', 'email', 'username', 'tngn_balance', 'bonus_balance_raw', 'bonus_balance_spendable', 'lifetime_credits', 'created_at', 'last_active_at'];
    const lines = rows.map((r) =>
      [r.id, r.email ?? '', r.username ?? '', r.tngn_balance, r.bonus_balance,
       spendableBonus(r.bonus_balance, r.bonus_expires_at),
       r.lifetime_credits, r.created_at ?? '', r.last_active_at ?? '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [header.join(','), ...lines].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `odds-users-page${page}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const issueCredit = async () => {
    if (!issueTarget || !issueAmount) return;
    const amt = Number(issueAmount);
    if (!amt || amt <= 0) {
      toast({ title: 'Enter a positive amount', variant: 'destructive' });
      return;
    }
    setIsIssuing(true);
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ userLookup: issueTarget.id, amount: amt, reason: issueReason }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      toast({ title: `Credited ₦${amt.toLocaleString()} to ${issueTarget.email || issueTarget.id.slice(0, 8)}` });
      setIssueTarget(null);
      setIssueAmount('');
      setIssueReason('');
      load();
    } catch (e: any) {
      toast({ title: 'Issue failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsIssuing(false);
    }
  };

  const columns: Column<UserRow>[] = [
    {
      key: 'email', label: 'User', sortable: true,
      sortValue: (u) => u.email || u.id,
      render: (u) => (
        <div className="flex flex-col">
          <span className="text-sm">{u.email || <span className="text-muted-foreground italic">no email</span>}</span>
          {u.username && <span className="text-[10px] text-muted-foreground">@{u.username}</span>}
        </div>
      ),
    },
    {
      key: 'tngn_balance', label: 'Wallet', sortable: true,
      sortValue: (u) => u.tngn_balance,
      render: (u) => <span className="font-medium">₦{u.tngn_balance.toLocaleString()}</span>,
    },
    {
      // Spendable, not raw. bonus_balance expires 7 days after each credit
      // (trg_users_bonus_expires); the raw column was shown here with no
      // regard for that, so an admin looking up a user with lapsed bonus saw
      // a live-looking number the user's own dashboard already reports as
      // zero — support staff would tell someone their bonus is fine while
      // the wallet screen right in front of them says it expired.
      key: 'bonus_balance', label: 'Bonus', sortable: true,
      sortValue: (u) => spendableBonus(u.bonus_balance, u.bonus_expires_at),
      render: (u) => {
        const live = spendableBonus(u.bonus_balance, u.bonus_expires_at);
        const note = bonusExpiryNote(u.bonus_balance, u.bonus_expires_at);
        return (
          <span className="text-amber-400 font-medium">
            ₦{live.toLocaleString()}
            {note && <span className="ml-1 text-[10px] text-muted-foreground font-normal">({note})</span>}
          </span>
        );
      },
    },
    {
      key: 'lifetime_credits', label: 'Lifetime credits', sortable: true,
      sortValue: (u) => u.lifetime_credits,
      render: (u) => <span className="text-emerald-400">₦{u.lifetime_credits.toLocaleString()}</span>,
    },
    {
      key: 'last_active_at', label: 'Last active', sortable: true,
      sortValue: (u) => new Date(u.last_active_at || u.created_at || 0).getTime(),
      render: (u) => {
        // Relative formatting at-a-glance ("3m ago", "2h ago"). Falls
        // back to created_at for accounts that pre-date the migration.
        const ts = u.last_active_at || u.created_at;
        if (!ts) return <span className="text-xs text-muted-foreground">—</span>;
        const diff = Date.now() - new Date(ts).getTime();
        const m = Math.floor(diff / 60000);
        const h = Math.floor(m / 60);
        const d = Math.floor(h / 24);
        const rel =
          m < 1   ? 'now' :
          m < 60  ? `${m}m ago` :
          h < 24  ? `${h}h ago` :
          d < 30  ? `${d}d ago` :
          new Date(ts).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' });
        const fresh = m < 60;
        return (
          <span className={cn('text-xs tabular-nums', fresh ? 'text-emerald-400' : 'text-muted-foreground')}>{rel}</span>
        );
      },
    },
    {
      key: 'actions', label: '',
      render: (u) => (
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setDetailUserId(u.id)}>
            <Eye className="w-3 h-3" /> View
          </Button>
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => setIssueTarget(u)}>
            <Gift className="w-3 h-3" /> Issue
          </Button>
        </div>
      ),
      className: 'text-right',
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4 text-blue-400" /> Users
              <Badge variant="outline">{total}</Badge>
            </CardTitle>
            <div className="flex gap-2">
              <Input
                placeholder="Search email or username…"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                className="h-8 w-56"
              />
              <Button size="sm" variant="outline" className="h-8" onClick={exportCsv}>Export CSV</Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-32 bg-muted/30 rounded-xl animate-pulse" />
          ) : (
            <>
              <DataTable
                rows={rows}
                columns={columns}
                rowKey={(u) => u.id}
                pageSize={pageSize}
                emptyMessage="No users match"
              />
              <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
                <span>Page {page} of {totalPages}</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>Prev</Button>
                  <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>Next</Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!issueTarget} onOpenChange={(open) => { if (!open) { setIssueTarget(null); setIssueAmount(''); setIssueReason(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Issue bonus credit</DialogTitle>
            <DialogDescription>
              Crediting <strong>{issueTarget?.email || issueTarget?.id.slice(0, 8)}</strong>. Funds land in <code className="text-xs">bonus_balance</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Amount (₦)</Label>
              <Input type="number" min={1} value={issueAmount} onChange={(e) => setIssueAmount(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Reason</Label>
              <Input value={issueReason} onChange={(e) => setIssueReason(e.target.value)} placeholder="goodwill, referral, comp…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIssueTarget(null)} disabled={isIssuing}>Cancel</Button>
            <Button onClick={issueCredit} disabled={isIssuing || !issueAmount}>
              {isIssuing ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Issuing…</> : 'Issue credit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Forensic detail drawer — fed by the "View" button on each row. */}
      <UserDetailDrawer userId={detailUserId} onClose={() => setDetailUserId(null)} />
    </>
  );
}

// ── Credits Issuance ──────────────────────────────────────────────────────
function CreditsPanel() {
  const { toast } = useToast();
  const [userLookup, setUserLookup] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [isIssuing, setIsIssuing] = useState(false);
  const [history, setHistory] = useState<any[]>([]);

  const loadHistory = useCallback(async () => {
    // Goes through /api/admin/credits (GET) because treasury_log is RLS-
    // locked to owner reads from authenticated clients now. Service-role
    // queries (this endpoint) still see every row.
    try {
      const res = await fetch('/api/admin/credits', { headers: adminHeaders() });
      if (!res.ok) return;
      const { history } = await res.json();
      setHistory(history || []);
    } catch {
      /* leave history empty */
    }
  }, []);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const handleIssue = async () => {
    const amt = Number(amount);
    if (!userLookup.trim() || !amt || amt <= 0) {
      toast({ title: 'Need a user and a positive amount', variant: 'destructive' });
      return;
    }
    setIsIssuing(true);
    try {
      const res = await fetch('/api/admin/credits', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ userLookup: userLookup.trim(), amount: amt, reason: reason.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      toast({
        title: `Credited ₦${amt.toLocaleString()}`,
        description: `New bonus balance: ₦${(data.newBonusBalance || 0).toLocaleString()}`,
      });
      setUserLookup('');
      setAmount('');
      setReason('');
      loadHistory();
    } catch (err: any) {
      toast({ title: 'Failed to issue credit', description: err.message, variant: 'destructive' });
    } finally {
      setIsIssuing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-pink-500/20">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Gift className="w-4 h-4 text-pink-400" />
            Issue Bonus Credits
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Credits go into <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">bonus_balance</code>
            {' '}— usable for bets, not withdrawable. Logged as <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">manual_credit</code>.
          </p>

          <div className="space-y-2">
            <Label>User (email or UUID)</Label>
            <Input
              placeholder="user@example.com or 2a4b…"
              value={userLookup}
              onChange={(e) => setUserLookup(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Amount (₦)</Label>
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" />
            </div>
            <div className="space-y-2">
              <Label>Reason</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Referral, goodwill, comp…" />
            </div>
          </div>

          <Button onClick={handleIssue} disabled={isIssuing} className="w-full gap-2">
            {isIssuing ? <><Loader2 className="w-4 h-4 animate-spin" />Issuing...</> : <><Gift className="w-4 h-4" />Issue Credit</>}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Recent manual credits</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No credits issued yet</p>
          ) : (
            <div className="space-y-2 max-h-80 overflow-y-auto">
              {history.map((h: any, i: number) => (
                <div key={i} className="flex items-center justify-between text-xs p-2 bg-muted/20 rounded-lg">
                  <div>
                    <span className="font-mono">{h.user_id?.slice(0, 8)}…</span>
                    {h.metadata?.reason && <span className="text-muted-foreground ml-2">— {h.metadata.reason}</span>}
                  </div>
                  <div className="flex gap-3">
                    <span className="font-semibold text-emerald-400">+₦{h.amount_tngn.toLocaleString()}</span>
                    <span className="text-muted-foreground">
                      {new Date(h.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── AI Market Generator ───────────────────────────────────────────────────
function AIMarketGenerator() {
  const { toast } = useToast();
  const [docText, setDocText] = useState('');
  const [docName, setDocName] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [parentOptions, setParentOptions] = useState<Array<{ id: number; question: string }>>([]);
  // Optional shared schedule applied to every approved draft on submit —
  // lets a whole batch of AI-generated markets go live together at a
  // chosen future time instead of the instant they're submitted.
  const [bulkScheduleEnabled, setBulkScheduleEnabled] = useState(false);
  const [bulkOpensAt, setBulkOpensAt] = useState('');
  // Locked odds on by default for AI-generated markets too — matches
  // every other creation surface. A shared seed size + vig applies to
  // every approved draft; binary drafts seed at an even 0.5 (no natural
  // skew to infer from a generated question) — use Clone & Edit
  // afterward on any specific one that needs a deliberate tilt.
  const [bulkLockedOddsEnabled, setBulkLockedOddsEnabled] = useState(true);
  const [bulkSeedSize, setBulkSeedSize] = useState('10000');
  const [bulkVigOverride, setBulkVigOverride] = useState('');

  // Load eligible parent markets once so each draft can opt to attach itself
  // as a sub-market on submit.
  useEffect(() => {
    supabase
      .from('markets')
      .select('id, question, status, parent_market_id')
      .in('status', ['open', 'locked'])
      .is('parent_market_id', null)
      .order('id', { ascending: false })
      .limit(100)
      .then(({ data }) => setParentOptions((data as any[]) || []));
  }, []);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setDocText(ev.target?.result as string || '');
    reader.readAsText(file);
  };

  const handleGenerate = async () => {
    if (!docText.trim()) {
      toast({ title: 'Paste or upload a document first', variant: 'destructive' });
      return;
    }
    setIsGenerating(true);
    try {
      const res = await fetch('/api/admin/generate-markets', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ documentContent: docText, documentName: docName }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) throw new Error('Admin session expired — refresh the page and sign in again.');
        throw new Error(data.error);
      }
      setDrafts(data.markets);
      toast({ title: `${data.markets.length} markets generated. Review and submit.` });
    } catch (err: any) {
      toast({ title: 'Generation failed', description: err.message, variant: 'destructive' });
    } finally { setIsGenerating(false); }
  };

  const updateDraft = (id: string, field: string, value: any) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, [field]: value } : d));
  };

  const removeDraft = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
  };

  const toggleApprove = (id: string) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, approved: !d.approved } : d));
  };

  const approveAll = () => setDrafts(prev => prev.map(d => ({ ...d, approved: true })));

  const handleSubmitApproved = async () => {
    const approved = drafts.filter(d => d.approved);
    if (approved.length === 0) {
      toast({ title: 'Approve at least one market first', variant: 'destructive' });
      return;
    }
    if (bulkScheduleEnabled && !bulkOpensAt) {
      toast({ title: 'Pick an open time, or turn scheduling off', variant: 'destructive' });
      return;
    }
    if (bulkLockedOddsEnabled && !(Number(bulkSeedSize) > 0)) {
      toast({ title: 'Enter a valid seed size, or turn locked odds off', variant: 'destructive' });
      return;
    }
    const opensAtIso = bulkScheduleEnabled && bulkOpensAt ? new Date(bulkOpensAt).toISOString() : null;
    setIsSubmitting(true);
    let created = 0;
    let failed = 0;
    for (const draft of approved) {
      try {
        const res = await fetch('/api/admin/market', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({
            question: draft.question,
            category: draft.category,
            sport: draft.sport,
            options: draft.options,
            closesAt: draft.closes_at,
            fixtureId: draft.fixture_id,
            homeTeam: draft.home_team,
            awayTeam: draft.away_team,
            description: draft.description,
            parentMarketId: draft.parent_market_id || null,
            opensAt: opensAtIso,
            isLockedOdds: bulkLockedOddsEnabled,
            seedSizeTngn: bulkLockedOddsEnabled ? Number(bulkSeedSize) : undefined,
            // Binary drafts need an explicit seed probability — no natural
            // skew to infer from a generated question, so seed even and
            // let the admin tilt specific ones later via Clone & Edit.
            // 3+ option drafts fall through to buildSeedPool's own
            // uniform-split fallback server-side.
            seedProbability: bulkLockedOddsEnabled && draft.options.length === 2 ? 0.5 : null,
            vigPct: bulkLockedOddsEnabled && bulkVigOverride.trim() !== '' ? Number(bulkVigOverride) : null,
          }),
        });
        if (res.ok) { created++; } else { failed++; }
      } catch { failed++; }
    }
    setDrafts(prev => prev.filter(d => !d.approved));
    toast({
      title: `${created} market${created !== 1 ? 's' : ''} ${opensAtIso ? 'scheduled' : 'created'}${failed > 0 ? `, ${failed} failed` : ''}`,
      description: opensAtIso ? `Opens automatically ${new Date(opensAtIso).toLocaleString()}.` : undefined,
    });
    setIsSubmitting(false);
  };

  const approvedCount = drafts.filter(d => d.approved).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            AI Market Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Paste a document (fixture list, news article, event schedule) or upload a text file.
            AI will generate prediction markets. You review and approve before anything goes live.
          </p>

          <div className="flex gap-2">
            <label className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg cursor-pointer hover:bg-muted/30 transition-colors text-sm">
              <Upload className="w-4 h-4" />
              Upload .txt or .csv
              <input type="file" accept=".txt,.csv,.md" className="sr-only" onChange={handleFileUpload} />
            </label>
            {docName && <span className="text-xs text-muted-foreground self-center truncate max-w-48">{docName}</span>}
          </div>

          <div className="space-y-2">
            <Label>Or paste document content directly</Label>
            <textarea
              className="w-full h-40 bg-muted/30 border border-border rounded-lg p-3 text-base md:text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Paste fixture lists, news, schedules, event briefs here..."
              value={docText}
              onChange={e => setDocText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground text-right">{docText.length.toLocaleString()} / 50,000 chars</p>
          </div>

          <Button onClick={handleGenerate} disabled={isGenerating || !docText.trim()} className="w-full gap-2">
            {isGenerating
              ? <><Loader2 className="w-4 h-4 animate-spin" />Generating markets...</>
              : <><Sparkles className="w-4 h-4" />Generate Markets with AI</>
            }
          </Button>
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Review Drafts ({drafts.length} generated, {approvedCount} approved)
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={approveAll}>
                  Approve All
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-500"
                  disabled={approvedCount === 0 || isSubmitting}
                  onClick={handleSubmitApproved}
                >
                  {isSubmitting
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Send className="w-3 h-3" />
                  }
                  Submit {approvedCount} Approved
                </Button>
              </div>
            </div>
            <div className="flex items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBulkScheduleEnabled(v => !v)}
                className={cn(
                  'text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 transition-colors',
                  bulkScheduleEnabled ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-border text-muted-foreground hover:bg-muted/30',
                )}
              >
                <CalendarClock className="w-3 h-3" />
                Schedule all approved for later
              </button>
              {bulkScheduleEnabled && (
                <Input
                  type="datetime-local"
                  value={bulkOpensAt}
                  onChange={e => setBulkOpensAt(e.target.value)}
                  className="h-7 text-xs w-56"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                onClick={() => setBulkLockedOddsEnabled(v => !v)}
                className={cn(
                  'text-xs px-2 py-1 rounded-md border flex items-center gap-1.5 transition-colors',
                  bulkLockedOddsEnabled ? 'border-amber-500/40 text-amber-300 bg-amber-500/10' : 'border-border text-muted-foreground hover:bg-muted/30',
                )}
              >
                <Sparkles className="w-3 h-3" />
                Locked odds for all approved
              </button>
              {bulkLockedOddsEnabled && (
                <>
                  <Input
                    type="number"
                    placeholder="Seed size ₦"
                    value={bulkSeedSize}
                    onChange={e => setBulkSeedSize(e.target.value)}
                    className="h-7 text-xs w-32"
                  />
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="Vig (default)"
                    value={bulkVigOverride}
                    onChange={e => setBulkVigOverride(e.target.value)}
                    className="h-7 text-xs w-28"
                  />
                  <span className="text-[10px] text-muted-foreground">
                    Binary drafts seed at 0.50 · 3+ options split evenly — adjust specific ones after via Clone &amp; Edit.
                  </span>
                </>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
              {drafts.map(draft => (
                <div
                  key={draft.id}
                  className={cn(
                    'border rounded-xl p-4 space-y-3 transition-all',
                    draft.approved ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={draft.approved}
                        onChange={() => toggleApprove(draft.id)}
                        className="mt-1 w-4 h-4 cursor-pointer accent-emerald-500"
                      />
                      <div className="flex-1 min-w-0 space-y-2">
                        <input
                          type="text"
                          value={draft.question}
                          onChange={e => updateDraft(draft.id, 'question', e.target.value)}
                          className="w-full bg-transparent text-sm font-medium border-b border-transparent hover:border-border focus:border-primary focus:outline-none pb-0.5"
                        />
                        <textarea
                          value={draft.description || ''}
                          onChange={e => updateDraft(draft.id, 'description', e.target.value)}
                          placeholder="Why this market matters — the cultural hook, rivalry, or stakes. Shown to users."
                          rows={2}
                          className="w-full bg-muted/20 border border-border/50 rounded-md px-2 py-1.5 text-xs text-muted-foreground resize-y focus:outline-none focus:ring-1 focus:ring-primary"
                        />
                      </div>
                    </div>
                    <button onClick={() => removeDraft(draft.id)} className="text-muted-foreground hover:text-red-400 transition-colors shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pl-7">
                    <div>
                      <Label className="text-xs">Category</Label>
                      <Select value={draft.category} onValueChange={v => updateDraft(draft.id, 'category', v)}>
                        <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sports">Sports</SelectItem>
                          <SelectItem value="politics">Politics</SelectItem>
                          <SelectItem value="economics">Economics</SelectItem>
                          <SelectItem value="entertainment">Entertainment</SelectItem>
                          <SelectItem value="finance">Finance</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Closes At</Label>
                      <Input
                        type="datetime-local"
                        value={draft.closes_at ? draft.closes_at.slice(0, 16) : ''}
                        onChange={e => updateDraft(draft.id, 'closes_at', new Date(e.target.value).toISOString())}
                        className="h-7 text-xs mt-1"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Options (comma-separated)</Label>
                      <Input
                        value={(draft.options as string[]).join(', ')}
                        onChange={e => updateDraft(draft.id, 'options', e.target.value.split(',').map((o: string) => o.trim()).filter(Boolean))}
                        className="h-7 text-xs mt-1"
                      />
                    </div>
                    <div className="col-span-2 md:col-span-4">
                      <Label className="text-xs">Parent Market (optional — makes this a sub-market)</Label>
                      <Select
                        value={draft.parent_market_id ? String(draft.parent_market_id) : 'none'}
                        onValueChange={(v) => updateDraft(draft.id, 'parent_market_id', v === 'none' ? null : parseInt(v))}
                      >
                        <SelectTrigger className="h-7 text-xs mt-1">
                          <SelectValue placeholder="Top-level (no parent)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">— None (top-level) —</SelectItem>
                          {parentOptions.map((m) => (
                            <SelectItem key={m.id} value={m.id.toString()}>
                              #{m.id}: {m.question.slice(0, 60)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="pl-7 flex flex-wrap gap-1">
                    {(draft.options as string[]).map((opt: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">{opt}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── VIP Account Manager ──────────────────────────────────────────────────
function VIPPanel() {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [rakeSharePct, setRakeSharePct] = useState('20');
  const [preloadBonus, setPreloadBonus] = useState('5000');
  // The signup bonus is the credit a NEW user gets when they redeem this
  // VIP's code — separate from preloadBonus which is the VIP's own
  // thank-you credit. Empty string means "use the server default" (500).
  const [signupBonus, setSignupBonus] = useState('500');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [recentVips, setRecentVips] = useState<any[]>([]);
  const [isLoadingVips, setIsLoadingVips] = useState(true);

  const loadVips = useCallback(async () => {
    setIsLoadingVips(true);
    // Service-role-backed endpoint — the previous version hit the
    // browser supabase client directly, which RLS quietly filtered to
    // an empty result no matter what was actually in the table.
    try {
      const res = await fetch('/api/admin/vip/list', { credentials: 'include' });
      if (!res.ok) {
        setRecentVips([]);
      } else {
        const data = await res.json();
        setRecentVips(data?.vips || []);
      }
    } catch {
      setRecentVips([]);
    } finally {
      setIsLoadingVips(false);
    }
  }, []);

  useEffect(() => { loadVips(); }, [loadVips]);

  const handleCreate = async () => {
    if (!email || !code) {
      toast({ title: 'Email and code required', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/vip/create', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim().toUpperCase(),
          rakeSharePct: Number(rakeSharePct) || 0,
          preloadBonus: Number(preloadBonus) || 0,
          signupBonus: signupBonus === '' ? undefined : Number(signupBonus),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      toast({
        title: `VIP created: ${json.code}`,
        description: `${rakeSharePct}% rake share · ₦${Number(preloadBonus).toLocaleString()} preload · ₦${Number(signupBonus || 500).toLocaleString()} per signup`,
      });
      setEmail(''); setCode(''); setRakeSharePct('20'); setPreloadBonus('5000'); setSignupBonus('500');
      loadVips();
    } catch (e: any) {
      toast({ title: 'VIP creation failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-amber-400" /> Promote to VIP
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">User Email</Label>
              <Input
                type="email"
                placeholder="trader@example.com"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Custom Referral Code</Label>
              <Input
                type="text"
                placeholder="e.g. AJALA25"
                value={code}
                onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                maxLength={20}
                className="font-mono tracking-wider"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Rake Share % (0–50)</Label>
              <Input
                type="number"
                min={0}
                max={50}
                value={rakeSharePct}
                onChange={e => setRakeSharePct(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">% of resolution rake from THIS VIP&apos;s referred users only.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Preload Bonus (tNGN)</Label>
              <Input
                type="number"
                min={0}
                value={preloadBonus}
                onChange={e => setPreloadBonus(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Credited to the VIP&apos;s own bonus_balance.</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Signup Bonus / referee (tNGN, 0–5000)</Label>
              <Input
                type="number"
                min={0}
                max={5000}
                value={signupBonus}
                onChange={e => setSignupBonus(e.target.value)}
              />
              <p className="text-[10px] text-muted-foreground">Credited to NEW users when they redeem this code.</p>
            </div>
          </div>
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-[11px] text-emerald-200/90">
            <strong className="text-emerald-300">VIP withdrawals:</strong> VIP earnings are credited to
            <code className="bg-emerald-500/10 px-1 rounded">bonus_balance</code>, which is never directly
            withdrawable. VIPs can freely withdraw their own deposits and prediction winnings
            (<code className="bg-emerald-500/10 px-1 rounded">tngn_balance</code>) — the old ₦10,000 lifetime-stake
            gate was removed because it only ever blocked money legitimately won from predictions.
          </div>
          <Button
            onClick={handleCreate}
            disabled={isSubmitting || !email || !code}
            className="w-full bg-amber-600 hover:bg-amber-500 text-white font-semibold"
          >
            {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Creating VIP…</> : 'Promote & Issue Code'}
          </Button>
        </CardContent>
      </Card>

      <div>
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-2">Active VIPs</h3>
        {isLoadingVips ? (
          <div className="space-y-2">
            {[...Array(3)].map((_, i) => <div key={i} className="h-16 rounded-xl shimmer" />)}
          </div>
        ) : recentVips.length === 0 ? (
          <p className="text-sm text-muted-foreground p-4 border border-dashed rounded-xl text-center">No VIP accounts yet.</p>
        ) : (
          <div className="space-y-2">
            {recentVips.map((v: any) => {
              const vipCode = (v.referral_codes || []).find((c: any) => c.is_vip_code);
              return (
                <div key={v.id} className="flex items-center justify-between p-3 bg-card/60 border border-amber-500/15 rounded-xl">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{v.email || v.id.slice(0, 8)}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {vipCode ? <>Code <span className="font-mono text-amber-300">{vipCode.code}</span> · {vipCode.uses_count} uses · {vipCode.rake_share_pct}% share</> : 'No VIP code'}
                    </p>
                  </div>
                  <div className="text-right shrink-0 ml-3">
                    <p className="text-xs text-muted-foreground">Bonus</p>
                    {/* Spendable, not raw — see the note on the Users table's
                        Bonus column for why the raw column reads wrong. */}
                    <p className="text-sm font-bold tabular-nums">
                      ₦{spendableBonus(v.bonus_balance, v.bonus_expires_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Data Reset Panel (pre-launch cleanup) ────────────────────────────────
function ResetPanel() {
  const { toast } = useToast();
  const [isResettingSquad, setIsResettingSquad] = useState(false);
  const [isResettingPaystack, setIsResettingPaystack] = useState(false);
  const [isResettingLaunch, setIsResettingLaunch] = useState(false);
  const [isResettingBalances, setIsResettingBalances] = useState(false);
  const [confirmSquad, setConfirmSquad] = useState(false);
  const [confirmPaystack, setConfirmPaystack] = useState(false);
  const [confirmLaunch, setConfirmLaunch] = useState(false);
  const [confirmBalances, setConfirmBalances] = useState(false);

  const executeReset = async (action: string, confirm: string, setIsLoading: any, setConfirm: any) => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, confirm }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Reset failed');

      const results = data.results || [];
      const summary = results.map((r: any) => `${r.table}: ${r.deleted ?? 'updated'} rows`).join(', ');
      toast({
        title: `${action.replace(/-/g, ' ')} completed`,
        description: summary || 'No changes.',
      });
      setConfirm(false);
    } catch (err: any) {
      toast({ title: 'Reset failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="border-red-500/20 bg-red-500/5">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2 text-red-400">
            <Trash2 className="w-4 h-4" />
            Data Reset (Pre-Launch Only)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-red-300/80">
            ⚠️ These operations are <strong>irreversible</strong>. Only use before launch to clear test/sandbox ledgers.
            After launch, decommission this endpoint entirely.
          </p>

          <div className="space-y-3">
            {/* Reset Squad + Treasury */}
            <Dialog open={confirmSquad} onOpenChange={setConfirmSquad}>
              <div className="border border-red-500/30 rounded-lg p-4 space-y-2">
                <h4 className="text-sm font-semibold">Reset Squad Deposits & Treasury</h4>
                <p className="text-xs text-muted-foreground">
                  Deletes all squad_transactions and Squad gateway treasury_movements.
                  Use to clear sandbox deposits before public launch.
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmSquad(true)}
                  disabled={isResettingSquad}
                  className="w-full"
                >
                  {isResettingSquad ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resetting…</> : 'Reset Squad'}
                </Button>
              </div>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm Squad Reset</DialogTitle>
                  <DialogDescription>
                    This will delete ALL squad_transactions and Squad treasury entries. This cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <p className="text-sm text-red-300">Are you absolutely sure?</p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmSquad(false)} disabled={isResettingSquad}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => executeReset('reset-deposits-squad', 'RESET DEPOSITS SQUAD', setIsResettingSquad, setConfirmSquad)}
                    disabled={isResettingSquad}
                  >
                    {isResettingSquad ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Confirm Reset Squad
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Reset Launch Data (bets + voided markets) */}
            <Dialog open={confirmLaunch} onOpenChange={setConfirmLaunch}>
              <div className="border border-red-500/30 rounded-lg p-4 space-y-2">
                <h4 className="text-sm font-semibold">Reset Launch Data (bets + voided markets)</h4>
                <p className="text-xs text-muted-foreground">
                  Clears every user_bet, deletes voided markets, and zeroes pool totals on
                  surviving markets. Leaves market catalogue (open/locked/resolved), user
                  balances, and treasury history intact. Fixes inflated Vol / Voided counts.
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmLaunch(true)}
                  disabled={isResettingLaunch}
                  className="w-full"
                >
                  {isResettingLaunch ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resetting…</> : 'Reset Launch Data'}
                </Button>
              </div>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm Launch Data Reset</DialogTitle>
                  <DialogDescription>
                    This will delete ALL user_bets, ALL voided markets, and zero pool totals on
                    every remaining market. Balances and treasury history are NOT touched. This
                    cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <p className="text-sm text-red-300">Are you absolutely sure?</p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmLaunch(false)} disabled={isResettingLaunch}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => executeReset('reset-launch-data', 'RESET LAUNCH DATA', setIsResettingLaunch, setConfirmLaunch)}
                    disabled={isResettingLaunch}
                  >
                    {isResettingLaunch ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Confirm Reset Launch Data
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Reset all user balances (zero tNGN + bonus across every user) */}
            <Dialog open={confirmBalances} onOpenChange={setConfirmBalances}>
              <div className="border border-red-500/30 rounded-lg p-4 space-y-2">
                <h4 className="text-sm font-semibold">Reset All User Balances</h4>
                <p className="text-xs text-muted-foreground">
                  Zeros <strong>tngn_balance</strong> and <strong>bonus_balance</strong> on every
                  user. Test credits gone. User accounts, bets, treasury, and markets are not touched.
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmBalances(true)}
                  disabled={isResettingBalances}
                  className="w-full"
                >
                  {isResettingBalances ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resetting…</> : 'Reset All Balances'}
                </Button>
              </div>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm Balance Reset</DialogTitle>
                  <DialogDescription>
                    This will zero tngn_balance AND bonus_balance on every user row. Cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <p className="text-sm text-red-300">Are you absolutely sure?</p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmBalances(false)} disabled={isResettingBalances}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => executeReset('reset-user-balances', 'RESET BALANCES', setIsResettingBalances, setConfirmBalances)}
                    disabled={isResettingBalances}
                  >
                    {isResettingBalances ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Confirm Reset Balances
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* Purge Paystack */}
            <Dialog open={confirmPaystack} onOpenChange={setConfirmPaystack}>
              <div className="border border-red-500/30 rounded-lg p-4 space-y-2">
                <h4 className="text-sm font-semibold">Purge Paystack Entirely</h4>
                <p className="text-xs text-muted-foreground">
                  Deletes paystack_transactions, Paystack treasury_movements, and any Paystack withdrawal records.
                  One-way operation — no Paystack residue will remain.
                </p>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmPaystack(true)}
                  disabled={isResettingPaystack}
                  className="w-full"
                >
                  {isResettingPaystack ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Purging…</> : 'Purge Paystack'}
                </Button>
              </div>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Confirm Paystack Purge</DialogTitle>
                  <DialogDescription>
                    This will delete ALL Paystack transactions, treasury entries, and withdrawal records. This cannot be undone.
                  </DialogDescription>
                </DialogHeader>
                <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
                  <p className="text-sm text-red-300">Are you absolutely sure?</p>
                </div>
                <DialogFooter>
                  <Button variant="outline" onClick={() => setConfirmPaystack(false)} disabled={isResettingPaystack}>
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={() => executeReset('purge-paystack', 'PURGE PAYSTACK', setIsResettingPaystack, setConfirmPaystack)}
                    disabled={isResettingPaystack}
                  >
                    {isResettingPaystack ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                    Confirm Purge Paystack
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <p className="text-[10px] text-muted-foreground pt-2 border-t border-muted">
            These are one-time operations. The endpoint will be disabled post-launch.
          </p>
        </CardContent>
      </Card>

      <DeleteSpecificMarketsPanel />
    </div>
  );
}

// ── Delete Specific Markets ──────────────────────────────────────────────
// Targeted removal: search + multi-select + cascade-aware delete. Sits
// alongside the bulk reset buttons since the destination (markets table)
// and danger profile are the same.
type MarketRow = {
  id: number;
  question: string;
  category: string | null;
  status: string;
  total_pool: number | null;
  parent_market_id: number | null;
  closes_at: string | null;
  child_count: number;
  is_trending: boolean;
  trending_rank: number | null;
};

function DeleteSpecificMarketsPanel() {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [rows, setRows] = useState<MarketRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Market_id of the row whose forensic drawer is currently open. The
  // panel doubles as the only place to BROWSE markets in admin, so the
  // View button + drawer also live here (despite the panel being
  // titled around deletion).
  const [detailMarketId, setDetailMarketId] = useState<number | null>(null);
  // Edit dialog target — same pattern as detailMarketId. Letting both
  // live in this panel keeps "browse / edit / delete a market" in one
  // physical place in admin, since they share search/filter context.
  const [editMarketId, setEditMarketId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      let q = supabase
        .from('markets')
        .select('id, question, category, status, total_pool, parent_market_id, closes_at, is_trending, trending_rank')
        .order('id', { ascending: false })
        .limit(50);
      if (statusFilter !== 'all') q = q.eq('status', statusFilter);
      const term = search.trim();
      if (term) {
        if (/^\d+$/.test(term)) q = q.eq('id', Number(term));
        else q = q.ilike('question', `%${term}%`);
      }
      const { data, error } = await q;
      if (error) throw error;

      const ids = (data || []).map((m: any) => m.id);
      let childCounts: Record<number, number> = {};
      if (ids.length > 0) {
        const { data: kids } = await supabase
          .from('markets')
          .select('parent_market_id')
          .in('parent_market_id', ids);
        for (const k of (kids || []) as any[]) {
          const pid = k.parent_market_id as number;
          childCounts[pid] = (childCounts[pid] || 0) + 1;
        }
      }

      setRows(
        (data || []).map((m: any) => ({
          id: m.id,
          question: m.question,
          category: m.category,
          status: m.status,
          total_pool: Number(m.total_pool || 0),
          parent_market_id: m.parent_market_id,
          closes_at: m.closes_at,
          child_count: childCounts[m.id] || 0,
          is_trending: !!m.is_trending,
          trending_rank: m.trending_rank === null || m.trending_rank === undefined ? null : Number(m.trending_rank),
        })),
      );
    } catch (e: any) {
      toast({ title: 'Failed to load markets', description: e.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [search, statusFilter, toast]);

  useEffect(() => { load(); }, [load]);

  const toggleOne = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => setSelected(new Set(rows.map(r => r.id)));
  const clearSelection = () => setSelected(new Set());

  const selectedRows = rows.filter(r => selected.has(r.id));
  const blockedRows = selectedRows.filter(r => r.child_count > 0);
  const canDelete = selectedRows.length > 0 && blockedRows.length === 0;

  // Optimistic flip — flip the row in state first so the UI feels instant,
  // roll back on API failure. Only the Trending tab on /markets reads this
  // flag, so a quick toggle should be reflected immediately.
  const toggleTrending = async (marketId: number, current: boolean) => {
    setRows(prev => prev.map(r => r.id === marketId ? { ...r, is_trending: !current } : r));
    try {
      const res = await fetch(`/api/admin/markets/${marketId}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ is_trending: !current }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update');
      }
      toast({
        title: !current ? 'Added to Trending' : 'Removed from Trending',
        description: `#${marketId}`,
      });
    } catch (e: any) {
      setRows(prev => prev.map(r => r.id === marketId ? { ...r, is_trending: current } : r));
      toast({ title: 'Toggle failed', description: e.message, variant: 'destructive' });
    }
  };

  // Manual ordering within the Trending tab — lower rank shows first,
  // null sorts last. Same optimistic-flip-then-rollback pattern as
  // toggleTrending.
  const setTrendingRank = async (marketId: number, previous: number | null, next: number | null) => {
    setRows(prev => prev.map(r => r.id === marketId ? { ...r, trending_rank: next } : r));
    try {
      const res = await fetch(`/api/admin/markets/${marketId}`, {
        method: 'PATCH',
        headers: adminHeaders(),
        body: JSON.stringify({ trending_rank: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update');
      }
    } catch (e: any) {
      setRows(prev => prev.map(r => r.id === marketId ? { ...r, trending_rank: previous } : r));
      toast({ title: 'Rank update failed', description: e.message, variant: 'destructive' });
    }
  };

  const executeDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch('/api/admin/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delete-markets',
          confirm: 'DELETE MARKETS',
          marketIds: Array.from(selected),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409 && data.blockedBy) {
          const offenders = Object.entries(data.blockedBy)
            .map(([pid, kids]: any) => `#${pid} has ${(kids as any[]).length} sub-market(s)`)
            .join('; ');
          throw new Error(`${data.error} — ${offenders}`);
        }
        throw new Error(data.error || 'Delete failed');
      }
      const summary = (data.results || [])
        .map((r: any) => `${r.table}: ${r.deleted ?? 0}`)
        .join(' · ');
      toast({ title: `Deleted ${selected.size} market(s)`, description: summary });
      setSelected(new Set());
      setConfirmOpen(false);
      load();
    } catch (e: any) {
      toast({ title: 'Delete failed', description: e.message, variant: 'destructive' });
    } finally {
      setIsDeleting(false);
    }
  };

  const f = (n: number) => `₦${Math.round(n || 0).toLocaleString()}`;

  return (
    <Card className="border-red-500/20 bg-red-500/5">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2 text-red-400">
          <Trash2 className="w-4 h-4" />
          Delete Specific Markets
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-red-300/80">
          Search → tick → delete. Walks the FK chain (bets, merkle commits, payouts) so deletion is complete.
          Markets with sub-markets are blocked — handle the children first.
        </p>

        <div className="flex flex-col md:flex-row gap-2">
          <Input
            placeholder="Search by question text or paste an ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="md:w-44"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="locked">Locked</SelectItem>
              <SelectItem value="resolved">Resolved</SelectItem>
              <SelectItem value="voided">Voided</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load} disabled={isLoading}>
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Refresh'}
          </Button>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <Button size="sm" variant="ghost" onClick={selectAllVisible} disabled={rows.length === 0}>
            Select all visible ({rows.length})
          </Button>
          <Button size="sm" variant="ghost" onClick={clearSelection} disabled={selected.size === 0}>
            Clear selection
          </Button>
          <span className="ml-auto text-muted-foreground">{selected.size} selected</span>
        </div>

        <div className="max-h-96 overflow-y-auto border border-red-500/20 rounded-lg divide-y divide-red-500/10">
          {rows.length === 0 && (
            <div className="text-center text-xs text-muted-foreground py-6">
              {isLoading ? 'Loading…' : 'No markets match your search.'}
            </div>
          )}
          {rows.map((m) => {
            const checked = selected.has(m.id);
            const blocked = m.child_count > 0;
            return (
              <div
                key={m.id}
                className={cn(
                  'flex items-start gap-3 px-3 py-2 hover:bg-red-500/5',
                  checked && 'bg-red-500/10',
                )}
              >
                <label className="flex items-start gap-3 flex-1 min-w-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleOne(m.id)}
                    className="mt-1 accent-red-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[10px] text-muted-foreground tabular-nums">#{m.id}</span>
                      <Badge className={cn('text-[10px] h-5',
                        m.status === 'open'     ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                        m.status === 'locked'   ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' :
                        m.status === 'resolved' ? 'bg-blue-500/20 text-blue-400 border-blue-500/30' :
                                                  'bg-muted text-muted-foreground border-muted')}>
                        {m.status.toUpperCase()}
                      </Badge>
                      {m.category && (
                        <Badge variant="outline" className="text-[10px] h-5">{m.category}</Badge>
                      )}
                      {blocked && (
                        <Badge className="text-[10px] h-5 bg-yellow-500/20 text-yellow-300 border-yellow-500/30">
                          {m.child_count} sub-market{m.child_count === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                    <div className="text-sm truncate">{m.question}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      Pool {f(m.total_pool || 0)}
                      {m.closes_at ? ` · closes ${new Date(m.closes_at).toLocaleDateString()}` : ''}
                    </div>
                  </div>
                </label>
                <div className="flex flex-col gap-1 shrink-0 mt-1">
                  <Button
                    size="sm"
                    variant={m.is_trending ? 'default' : 'outline'}
                    className={cn(
                      'h-7 text-xs gap-1',
                      m.is_trending && 'bg-orange-500 hover:bg-orange-600 text-black border-orange-500',
                    )}
                    onClick={(e) => { e.stopPropagation(); toggleTrending(m.id, m.is_trending); }}
                    title={m.is_trending ? 'Remove from Trending tab' : 'Add to Trending tab'}
                  >
                    <Flame className="w-3 h-3" /> {m.is_trending ? 'Trending' : 'Trend'}
                  </Button>
                  {m.is_trending && (
                    <Input
                      type="number"
                      defaultValue={m.trending_rank ?? ''}
                      placeholder="Rank"
                      key={`rank-${m.id}-${m.trending_rank ?? 'null'}`}
                      className="h-7 text-xs px-2 w-16"
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const raw = e.target.value.trim();
                        const next = raw === '' ? null : Math.trunc(Number(raw));
                        if (next !== null && !Number.isFinite(next)) return;
                        if (next === m.trending_rank) return;
                        setTrendingRank(m.id, m.trending_rank, next);
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                      title="Manual position in the Trending tab — lower shows first, blank sorts last"
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => setEditMarketId(m.id)}
                    title="Edit question, description, options, and close time"
                  >
                    <Pencil className="w-3 h-3" /> Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs gap-1"
                    onClick={() => setDetailMarketId(m.id)}
                  >
                    <Eye className="w-3 h-3" /> View
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {blockedRows.length > 0 && (
          <div className="text-xs bg-yellow-500/10 border border-yellow-500/30 rounded-md px-3 py-2 text-yellow-300">
            {blockedRows.length} selected market{blockedRows.length === 1 ? ' has' : 's have'} sub-markets and
            cannot be deleted until their children are removed first.
          </div>
        )}

        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            variant="destructive"
            size="sm"
            disabled={!canDelete || isDeleting}
            onClick={() => setConfirmOpen(true)}
            className="w-full"
          >
            {isDeleting
              ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Deleting…</>
              : `Delete ${selected.size || 'selected'} market${selected.size === 1 ? '' : 's'}`}
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Confirm market deletion</DialogTitle>
              <DialogDescription>
                The following {selectedRows.length} market{selectedRows.length === 1 ? '' : 's'} and
                ALL related bets, payouts, and merkle commits will be permanently deleted.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-60 overflow-y-auto bg-red-500/10 border border-red-500/30 rounded-md p-2 space-y-1">
              {selectedRows.map((m) => (
                <div key={m.id} className="text-xs flex items-center gap-2">
                  <span className="text-muted-foreground tabular-nums">#{m.id}</span>
                  <span className="truncate">{m.question}</span>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={isDeleting}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={executeDelete} disabled={isDeleting}>
                {isDeleting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Confirm Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>

      {/* Forensic drawer for the row's "View" button. Shared with the */}
      {/* admin's market browse flow so a single instance is enough.   */}
      <MarketDetailDrawer marketId={detailMarketId} onClose={() => setDetailMarketId(null)} />
      <MarketEditDialog
        marketId={editMarketId}
        onClose={() => setEditMarketId(null)}
        onSaved={() => load()}
      />
    </Card>
  );
}

// ── Main Admin Page ───────────────────────────────────────────────────────
export default function AdminPage() {
  const [session, setSession] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminInput, setAdminInput] = useState('');
  const [isChecking, setIsChecking] = useState(true);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });
    // Check for an existing admin cookie set by /api/admin/auth.
    fetch('/api/admin/auth')
      .then((res) => { if (res.ok) setIsAdmin(true); })
      .finally(() => setIsChecking(false));
  }, []);

  const handleAdminLogin = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const res = await fetch('/api/admin/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: adminInput }),
      });
      if (res.ok) {
        setIsAdmin(true);
        setAdminInput('');
      } else {
        setLoginError('Invalid admin secret');
      }
    } catch {
      setLoginError('Network error');
    } finally {
      setIsLoggingIn(false);
    }
  };

  if (isChecking) return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-80">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" /> Admin Access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              placeholder="Admin secret"
              value={adminInput}
              onChange={e => setAdminInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdminLogin()}
            />
            {loginError && <p className="text-xs text-destructive">{loginError}</p>}
            <Button className="w-full" onClick={handleAdminLogin} disabled={isLoggingIn || !adminInput}>
              {isLoggingIn ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Verifying…</> : 'Enter'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-8 pb-24 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6 text-amber-400" /> Opinions.ng Admin
        </h1>
        <Badge variant="outline" className="text-emerald-400 border-emerald-400/30">Live</Badge>
      </div>

      <Tabs defaultValue="treasury">
        <TabsList className="grid w-full grid-cols-4 md:grid-cols-9">
          <TabsTrigger value="treasury">Treasury</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="leaderboard">Leaderboard</TabsTrigger>
          <TabsTrigger value="vip">VIP</TabsTrigger>
          <TabsTrigger value="create">Create</TabsTrigger>
          <TabsTrigger value="override">Override</TabsTrigger>
          <TabsTrigger value="void">Void</TabsTrigger>
          <TabsTrigger value="withdrawals">Withdrawals</TabsTrigger>
          <TabsTrigger value="credits">Credits</TabsTrigger>
          <TabsTrigger value="reset">Reset</TabsTrigger>
        </TabsList>

        <TabsContent value="treasury" className="pt-4"><TreasuryPanel /></TabsContent>
        <TabsContent value="users" className="pt-4"><UsersPanel /></TabsContent>
        <TabsContent value="leaderboard" className="pt-4"><LeaderboardPreviewPanel /></TabsContent>
        <TabsContent value="vip" className="pt-4"><VIPPanel /></TabsContent>
        <TabsContent value="create" className="pt-4">
          <MarketCreationHub />
        </TabsContent>
        <TabsContent value="override" className="pt-4"><ManualOverridePanel /></TabsContent>
        <TabsContent value="void" className="pt-4"><VoidPanel /></TabsContent>
        <TabsContent value="withdrawals" className="pt-4"><WithdrawalPanel /></TabsContent>
        <TabsContent value="credits" className="pt-4"><CreditsPanel /></TabsContent>
        <TabsContent value="reset" className="pt-4"><ResetPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
