'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { WalletModal } from '@/components/WalletModal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  TrendingUp, TrendingDown, Zap, BarChart3, Target,
  Copy, Check, Shield, Bell, LogOut, ChevronRight, Trophy
} from 'lucide-react';
import { cn } from '@/lib/utils';

const AVATAR_THEME: [string, string, string, string][] = [
  ['#6366f1','#8b5cf6','#c4b5fd','◈'],['#0ea5e9','#38bdf8','#7dd3fc','◎'],
  ['#f43f5e','#fb7185','#fda4af','◇'],['#10b981','#34d399','#6ee7b7','⬡'],
  ['#f59e0b','#fbbf24','#fde68a','◉'],['#8b5cf6','#a78bfa','#ddd6fe','◊'],
  ['#06b6d4','#22d3ee','#a5f3fc','⬢'],['#ef4444','#f87171','#fca5a5','◈'],
  ['#84cc16','#a3e635','#d9f99d','◎'],['#f97316','#fb923c','#fdba74','◇'],
  ['#ec4899','#f472b6','#f9a8d4','◉'],['#14b8a6','#2dd4bf','#99f6e4','◊'],
  ['#6366f1','#a78bfa','#e9d5ff','⬡'],['#0284c7','#0ea5e9','#bae6fd','⬢'],
  ['#dc2626','#ef4444','#fee2e2','◈'],['#059669','#10b981','#d1fae5','◎'],
  ['#d97706','#f59e0b','#fef3c7','◇'],['#7c3aed','#8b5cf6','#ede9fe','◉'],
  ['#0891b2','#06b6d4','#cffafe','◊'],['#db2777','#ec4899','#fce7f3','⬡'],
  ['#65a30d','#84cc16','#ecfccb','⬢'],['#ea580c','#f97316','#ffedd5','◈'],
  ['#9333ea','#a855f7','#f3e8ff','◎'],['#0369a1','#0284c7','#e0f2fe','◇'],
  ['#b91c1c','#dc2626','#fee2e2','◉'],['#047857','#059669','#d1fae5','◊'],
  ['#b45309','#d97706','#fef3c7','⬡'],['#6d28d9','#7c3aed','#ede9fe','⬢'],
  ['#0e7490','#0891b2','#cffafe','◈'],['#be185d','#db2777','#fce7f3','◎'],
  ['#4d7c0f','#65a30d','#ecfccb','◇'],['#c2410c','#ea580c','#ffedd5','◉'],
  ['#7e22ce','#9333ea','#f3e8ff','◊'],['#075985','#0369a1','#e0f2fe','⬡'],
  ['#991b1b','#b91c1c','#fee2e2','⬢'],['#065f46','#047857','#d1fae5','◈'],
  ['#92400e','#b45309','#fef3c7','◎'],['#5b21b6','#6d28d9','#ede9fe','◇'],
  ['#164e63','#0e7490','#cffafe','◉'],['#9d174d','#be185d','#fce7f3','◊'],
  ['#3f6212','#4d7c0f','#ecfccb','⬡'],['#9a3412','#c2410c','#ffedd5','⬢'],
  ['#581c87','#7e22ce','#f3e8ff','◈'],['#0c4a6e','#075985','#e0f2fe','◎'],
  ['#7f1d1d','#991b1b','#fee2e2','◇'],['#064e3b','#065f46','#d1fae5','◉'],
  ['#78350f','#92400e','#fef3c7','◊'],['#4c1d95','#5b21b6','#ede9fe','⬡'],
  ['#083344','#164e63','#cffafe','⬢'],['#831843','#9d174d','#fce7f3','◈'],
];

function AvatarSVG({ id, size = 48 }: { id: number; size?: number }) {
  const [bg1, bg2, accent, symbol] = AVATAR_THEME[id % AVATAR_THEME.length];
  const gradId = `av${id}_${size}`;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id={gradId} cx="35%" cy="30%">
          <stop offset="0%" stopColor={bg1} />
          <stop offset="100%" stopColor={bg2} />
        </radialGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill={`url(#${gradId})`} />
      <text x="24" y="32" textAnchor="middle" fontSize="22" fill={accent} fontFamily="monospace">{symbol}</text>
    </svg>
  );
}

function HeatmapGrid({ data }: { data: Record<string, { pnl: number; count: number }> }) {
  const days = Object.entries(data).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div>
      <div className="flex gap-1 flex-wrap">
        {days.map(([date, { pnl, count }]) => {
          let bg = 'bg-muted/30';
          let title = `${date}: No bets`;
          if (count > 0) {
            if (pnl > 0) {
              const i = Math.min(pnl / 5000, 1);
              bg = i > 0.6 ? 'bg-emerald-400' : i > 0.3 ? 'bg-emerald-500/70' : 'bg-emerald-600/40';
            } else if (pnl < 0) {
              const i = Math.min(Math.abs(pnl) / 5000, 1);
              bg = i > 0.6 ? 'bg-red-400' : i > 0.3 ? 'bg-red-500/70' : 'bg-red-600/40';
            } else { bg = 'bg-blue-500/40'; }
            title = `${date}: ${pnl >= 0 ? '+' : ''}₦${pnl.toLocaleString()} (${count} bet${count !== 1 ? 's' : ''})`;
          }
          return <div key={date} title={title} className={cn('w-[10px] h-[10px] rounded-[2px] cursor-pointer transition-transform hover:scale-125', bg)} />;
        })}
      </div>
      <div className="flex items-center gap-3 mt-3 text-xs text-muted-foreground">
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-muted/30" /> No bets</div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-emerald-500/70" /> Profitable</div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-sm bg-red-500/70" /> Loss</div>
      </div>
    </div>
  );
}

function StatCard({ label, value, sub, icon: Icon, color }: { label: string; value: string | number; sub?: string; icon: any; color: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
        <Icon className={cn('w-4 h-4', color)} />
      </div>
      <div className="text-2xl font-bold tracking-tight">{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

export default function ProfilePage() {
  const [session, setSession] = useState<any>(null);
  const [profile, setProfile] = useState<any>(null);
  const [stats, setStats] = useState<any>(null);
  const [heatmap, setHeatmap] = useState<Record<string, any>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  const fetchProfile = useCallback(async () => {
    if (!session?.access_token) return;
    setIsLoading(true);
    try {
      const res = await fetch('/api/user/profile', {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error('Failed to load profile');
      const data = await res.json();
      setProfile(data.profile);
      setStats(data.stats);
      setHeatmap(data.heatmap);
    } catch {
      toast({ title: 'Error loading profile', variant: 'destructive' });
    } finally { setIsLoading(false); }
  }, [session?.access_token, toast]);

  useEffect(() => { fetchProfile(); }, [fetchProfile]);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  const copyUserId = () => {
    if (!session?.user?.id) return;
    navigator.clipboard.writeText(session.user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <Shield className="w-12 h-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Sign in to view your profile</p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="max-w-2xl mx-auto p-4 sm:p-8 space-y-4 animate-pulse">
        <div className="h-48 bg-muted rounded-2xl" />
        <div className="grid grid-cols-2 gap-3">{[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-muted rounded-xl" />)}</div>
        <div className="h-20 bg-muted rounded-xl" />
      </div>
    );
  }

  const displayName = profile?.username || profile?.first_name || session?.user?.email?.split('@')[0] || 'Anon';
  const avatarId = profile?.avatar_id ?? 0;
  const netProfit = (stats?.totalPayout || 0) - (stats?.totalVolume || 0);

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-8 space-y-5 pb-24">
      {/* Hero */}
      <div className="bg-gradient-to-br from-card to-card/50 border border-border rounded-2xl p-6">
        <div className="flex items-start gap-4">
          <div className="ring-2 ring-primary/30 rounded-[14px] shrink-0">
            <AvatarSVG id={avatarId} size={56} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight">@{displayName}</h1>
              {stats?.winRate >= 60 && (
                <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[10px]">🔥 Hot Streak</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground truncate">{session?.user?.email}</p>
            <button onClick={copyUserId} className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-muted-foreground mt-1 transition-colors">
              {copied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              <span className="font-mono">{session?.user?.id?.slice(0, 16)}...</span>
            </button>
          </div>
        </div>

        <div className="mt-6 pt-6 border-t border-border">
          <p className="text-xs text-muted-foreground uppercase tracking-widest mb-1">Available Balance</p>
          <div className="flex items-end gap-2 mb-1">
            <span className="text-4xl font-black tracking-tighter">₦{(profile?.tngn_balance || 0).toLocaleString()}</span>
            <span className="text-base text-muted-foreground mb-1">tNGN</span>
          </div>
          {(profile?.bonus_balance || 0) > 0 && (
            <p className="text-sm text-amber-400 mb-4">+₦{profile.bonus_balance.toLocaleString()} bonus credit</p>
          )}
          {(profile?.free_bet_credits || 0) > 0 && (
            <p className="text-sm text-emerald-400 mb-4">+₦{profile.free_bet_credits.toLocaleString()} free bet credit 🛡</p>
          )}
          <div className="mt-4"><WalletModal /></div>
        </div>
      </div>

      {/* Ego Metrics */}
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Win Rate" value={`${stats?.winRate || 0}%`} sub={`${stats?.wonBets || 0}/${stats?.resolvedBets || 0} resolved`} icon={Target} color={stats?.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCard label="Total Volume" value={`₦${((stats?.totalVolume || 0) / 1000).toFixed(1)}k`} sub="All-time staked" icon={BarChart3} color="text-blue-400" />
        <StatCard label="Net P&L" value={`${netProfit >= 0 ? '+' : ''}₦${Math.abs(netProfit).toLocaleString()}`} sub="Winnings minus stakes" icon={netProfit >= 0 ? TrendingUp : TrendingDown} color={netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatCard label="Active Slips" value={stats?.activeBets || 0} sub="Bets in play right now" icon={Zap} color="text-amber-400" />
      </div>

      {/* Heatmap */}
      <div className="bg-card border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Trophy className="w-4 h-4 text-amber-400" />
          <h2 className="font-semibold text-sm">30-Day Betting Activity</h2>
        </div>
        {Object.keys(heatmap).length > 0
          ? <HeatmapGrid data={heatmap} />
          : <p className="text-sm text-muted-foreground">Place your first bet to see activity here.</p>
        }
      </div>

      {/* Account Menu */}
      <div className="bg-card border border-border rounded-xl overflow-hidden">
        <div className="px-5 py-3 border-b border-border">
          <h2 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">Account</h2>
        </div>
        <div className="divide-y divide-border">
          <a href="/profile/edit" className="flex items-center justify-between px-5 py-4 hover:bg-muted/30 transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                <AvatarSVG id={avatarId} size={28} />
              </div>
              <div><p className="text-sm font-medium">Edit Profile</p><p className="text-xs text-muted-foreground">Username, avatar, display name</p></div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </a>
          <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center"><Shield className="w-4 h-4 text-blue-400" /></div>
              <div><p className="text-sm font-medium">Cryptographic Protection</p><p className="text-xs text-muted-foreground">Escape hatch contract active</p></div>
            </div>
            <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 text-[10px]">Active</Badge>
          </div>
          <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center"><Bell className="w-4 h-4 text-muted-foreground" /></div>
              <div><p className="text-sm font-medium">Notifications</p><p className="text-xs text-muted-foreground">Bet results, payouts, deposits</p></div>
            </div>
            <ChevronRight className="w-4 h-4 text-muted-foreground" />
          </div>
          <button onClick={handleSignOut} className="w-full flex items-center gap-3 px-5 py-4 hover:bg-red-500/5 transition-colors text-red-400">
            <div className="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center"><LogOut className="w-4 h-4" /></div>
            <span className="text-sm font-medium">Sign Out</span>
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/50 text-center flex items-center justify-center gap-1 pb-4">
        <Shield className="w-3 h-3" /> Your funds are cryptographically protected on Polygon.
      </p>
    </div>
  );
}
