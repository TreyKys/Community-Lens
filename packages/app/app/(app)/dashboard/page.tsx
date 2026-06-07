'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Wallet, Gift, Trophy, Sparkles, Crown, Copy, Check,
  TrendingUp, Clock, ChevronRight, Loader2, Lock,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { getDisplayPool } from '@/lib/displayPool';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

interface DashboardProfile {
  id: string;
  tngn_balance: number;
  bonus_balance: number;
  points: number;
  is_vip: boolean;
}

interface ReferralCode {
  code: string;
  is_vip_code: boolean;
  rake_share_pct: number;
  uses_count: number;
}

interface ActiveStake {
  id: string;
  stake_tngn: number;
  outcome_index: number;
  placed_at: string;
  markets: {
    id: number;
    question: string;
    options: string[];
    total_pool: number;
    status: string;
    closes_at: string;
  };
}

export default function DashboardPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [profile, setProfile] = useState<DashboardProfile | null>(null);
  const [code, setCode] = useState<ReferralCode | null>(null);
  const [stakes, setStakes] = useState<ActiveStake[]>([]);
  const [vipEarnings, setVipEarnings] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isSettingPassword, setIsSettingPassword] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.replace('/');
        return;
      }
      const uid = session.user.id;

      const [{ data: prof }, { data: codeRow }, { data: stakeRows }, { data: earnings }] = await Promise.all([
        supabase.from('users')
          .select('id, tngn_balance, bonus_balance, points, is_vip')
          .eq('id', uid).single(),
        supabase.from('referral_codes')
          .select('code, is_vip_code, rake_share_pct, uses_count')
          .eq('owner_user_id', uid)
          .order('is_vip_code', { ascending: false })
          .limit(1).maybeSingle(),
        supabase.from('user_bets')
          .select('id, stake_tngn, outcome_index, placed_at, markets(id, question, options, total_pool, status, closes_at)')
          .eq('user_id', uid)
          .eq('status', 'active')
          .order('placed_at', { ascending: false })
          .limit(6),
        supabase.from('vip_referral_earnings')
          .select('rake_share_amount')
          .eq('vip_user_id', uid),
      ]);

      if (cancelled) return;
      setProfile(prof as DashboardProfile);
      setCode((codeRow as ReferralCode | null) || null);
      setStakes((stakeRows as any) || []);
      setVipEarnings(
        Array.isArray(earnings)
          ? earnings.reduce((s, e: any) => s + Number(e.rake_share_amount || 0), 0)
          : 0
      );
      setIsLoading(false);

      // Realtime — balance + points
      const ch = supabase
        .channel(`dashboard:${uid}`)
        .on('postgres_changes', {
          event: 'UPDATE',
          schema: 'public',
          table: 'users',
          filter: `id=eq.${uid}`,
        }, async () => {
          const { data: fresh } = await supabase.from('users')
            .select('id, tngn_balance, bonus_balance, points, is_vip')
            .eq('id', uid).single();
          if (fresh) setProfile(fresh as DashboardProfile);
        })
        .subscribe();

      return () => { supabase.removeChannel(ch); };
    })();
    return () => { cancelled = true; };
  }, [router]);

  const copyReferral = () => {
    if (!code) return;
    const url = `${typeof window !== 'undefined' ? window.location.origin : ''}/?ref=${code.code}`;
    try {
      navigator.clipboard.writeText(url);
      setCopied(true);
      toast({ title: 'Referral link copied' });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast({ title: 'Password too short', description: 'Minimum 8 characters', variant: 'destructive' });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: 'Passwords don\'t match', variant: 'destructive' });
      return;
    }

    setIsSettingPassword(true);
    try {
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      toast({ title: 'Password set successfully', description: 'You can now log in with your password.' });
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordForm(false);
    } catch (error: any) {
      toast({ title: 'Error', description: error.message, variant: 'destructive' });
    } finally {
      setIsSettingPassword(false);
    }
  };

  if (isLoading || !profile) {
    return (
      <div className="px-3 py-4 md:p-6 space-y-3">
        <div className="h-32 rounded-2xl shimmer" />
        <div className="grid grid-cols-3 gap-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-24 rounded-xl shimmer" />)}
        </div>
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => <div key={i} className="h-20 rounded-xl shimmer" />)}
        </div>
      </div>
    );
  }

  const isVip = profile.is_vip;
  const totalBalance = (profile.tngn_balance || 0) + (profile.bonus_balance || 0);

  return (
    <div className="px-3 py-4 md:p-6 space-y-5 max-w-3xl mx-auto">
      {/* Hero balance card */}
      <Card className={cn(
        'overflow-hidden border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-transparent relative',
        isVip && 'border-amber-500/40 from-amber-500/10 via-emerald-500/5'
      )}>
        <CardContent className="p-5 relative z-10">
          <div className="flex items-start justify-between mb-2">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Total Balance</p>
              <p className="text-4xl md:text-5xl font-black tracking-tight tabular-nums mt-1">
                ₦<AnimatedNumber value={totalBalance} />
              </p>
            </div>
            {isVip && (
              <Badge className="bg-amber-500/20 text-amber-300 border-amber-500/40 gap-1">
                <Crown className="w-3 h-3" /> VIP
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <div className="bg-background/40 backdrop-blur rounded-lg p-3 border border-emerald-500/20">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Wallet className="w-3 h-3" /> Actual
              </p>
              <p className="text-lg font-bold mt-1 tabular-nums">
                ₦<AnimatedNumber value={profile.tngn_balance || 0} />
              </p>
              <p className="text-[10px] text-muted-foreground/70">Withdrawable</p>
            </div>
            <div className="bg-background/40 backdrop-blur rounded-lg p-3 border border-amber-500/20">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Gift className="w-3 h-3" /> Bonus
              </p>
              <p className="text-lg font-bold mt-1 tabular-nums">
                ₦<AnimatedNumber value={profile.bonus_balance || 0} />
              </p>
              <p className="text-[10px] text-muted-foreground/70">Wager to unlock</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats row */}
      <div className={cn('grid gap-2', isVip ? 'grid-cols-2' : 'grid-cols-1')}>
        <Card className="border-emerald-500/15">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Trophy className="w-3 h-3" /> Leaderboard Points
              </p>
              <p className="text-2xl font-bold tabular-nums mt-1">
                <AnimatedNumber value={profile.points || 0} />
              </p>
            </div>
            <Link href="/leaderboard" className="text-emerald-400 hover:text-emerald-300 transition-colors">
              <ChevronRight className="w-5 h-5" />
            </Link>
          </CardContent>
        </Card>

        {isVip && (
          <Card className="border-amber-500/25">
            <CardContent className="p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> VIP Cut Earned
              </p>
              <p className="text-2xl font-bold tabular-nums mt-1 text-amber-300">
                ₦<AnimatedNumber value={vipEarnings} />
              </p>
              <p className="text-[10px] text-muted-foreground/70 mt-1">
                {code?.rake_share_pct ?? 0}% of rake from your referrals
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Referral card */}
      {code && (
        <Card className="border-emerald-500/15">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                {code.is_vip_code ? <Crown className="w-3.5 h-3.5 text-amber-400" /> : <Sparkles className="w-3.5 h-3.5 text-emerald-400" />}
                Your Referral Code
              </p>
              <p className="text-[10px] text-muted-foreground">{code.uses_count} use{code.uses_count !== 1 ? 's' : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex-1 bg-background/60 border border-emerald-500/20 rounded-lg px-3 py-2 font-mono text-base tracking-widest">
                {code.code}
              </div>
              <button
                onClick={copyReferral}
                className="px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1.5 transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copied ? 'Copied' : 'Share'}
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2">
              {code.is_vip_code
                ? `Each referee earns you 1000 pts + ${code.rake_share_pct}% of every rake from their bets.`
                : 'Each referee earns you 200 pts + ₦200 in bonus credits when they sign up.'}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Password management */}
      <Card className="border-emerald-500/15">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-semibold text-foreground flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-emerald-400" />
              Account Security
            </p>
          </div>
          {!showPasswordForm ? (
            <Button
              onClick={() => setShowPasswordForm(true)}
              variant="outline"
              className="w-full"
            >
              Set or Change Password
            </Button>
          ) : (
            <form onSubmit={handleSetPassword} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-pwd" className="text-xs">New Password</Label>
                <Input
                  id="new-pwd"
                  type="password"
                  placeholder="At least 8 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm-pwd" className="text-xs">Confirm Password</Label>
                <Input
                  id="confirm-pwd"
                  type="password"
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="submit"
                  className="flex-1"
                  disabled={isSettingPassword || newPassword.length < 8}
                >
                  {isSettingPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save Password'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowPasswordForm(false);
                    setNewPassword('');
                    setConfirmPassword('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )}
        </CardContent>
      </Card>

      {/* Active stakes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-400" /> Your Active Stakes
          </h2>
          <Link href="/bets" className="text-[11px] text-emerald-400 hover:text-emerald-300">
            See all →
          </Link>
        </div>
        {stakes.length === 0 ? (
          <div className="p-6 text-center border border-dashed border-border/60 rounded-xl">
            <p className="text-sm text-muted-foreground mb-2">No active stakes yet.</p>
            <Link href="/markets" className="inline-flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300 font-medium">
              Browse markets <ChevronRight className="w-4 h-4" />
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {stakes.map(s => {
              const opt = s.markets?.options?.[s.outcome_index] || `Option ${s.outcome_index}`;
              return (
                <Link
                  key={s.id}
                  href={`/event/${s.markets?.id}`}
                  className="block bg-card border border-border/60 rounded-xl p-3 hover:border-emerald-500/30 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <p className="text-sm font-medium line-clamp-1 flex-1">{s.markets?.question}</p>
                    <Badge variant="outline" className="text-[10px] shrink-0">{opt}</Badge>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Wallet className="w-3 h-3" />
                      Staked ₦{(s.stake_tngn || 0).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" />
                      Pool ₦{getDisplayPool(s.markets?.total_pool).toLocaleString()}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      {new Date(s.markets?.closes_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
