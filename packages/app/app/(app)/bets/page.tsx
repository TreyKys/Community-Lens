'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { motion, AnimatePresence } from 'framer-motion';
import { fireWinConfetti } from '@/lib/confetti';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import {
  Download, Share2, TrendingUp, TrendingDown,
  Clock, CheckCircle2, XCircle, Shield,
  Trophy, AlertCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface Bet {
  id: string;
  market_id: string;
  outcome_index: number;
  stake_tngn: number;
  net_stake_tngn: number;
  payout_tngn: number | null;
  is_jackpot_eligible: boolean;
  is_first_bet_refunded: boolean;
  status: 'active' | 'won' | 'lost' | 'refunded';
  placed_at: string;
  markets: {
    id: string;
    title: string;
    question: string;
    options: string[];
    status: string;
    closes_at: string;
    merkle_root: string | null;
  };
}

function BetCard({ bet, onDownloadReceipt, onShareCard }: {
  bet: Bet;
  onDownloadReceipt: (betId: string) => void;
  onShareCard: (bet: Bet) => void;
}) {
  const options = bet.markets?.options as string[] || [];
  const predicted = options[bet.outcome_index] || `Option ${bet.outcome_index}`;
  const profit = bet.status === 'won' ? (bet.payout_tngn || 0) - bet.stake_tngn : -bet.stake_tngn;
  const isLocked = bet.markets?.merkle_root != null;
  const closesAt = new Date(bet.markets?.closes_at);
  const isExpired = closesAt < new Date();

  const statusConfig = {
    active: { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', label: isExpired ? 'Awaiting Result' : 'In Play' },
    won: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Won' },
    lost: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'Lost' },
    refunded: { icon: Shield, color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/20', label: 'Refunded' },
  };

  const cfg = statusConfig[bet.status];
  const Icon = cfg.icon;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={cn('bg-card border rounded-xl overflow-hidden transition-all', cfg.border)}
    >
      <div className={cn('px-4 py-2 flex items-center justify-between', cfg.bg)}>
        <div className="flex items-center gap-2">
          <Icon className={cn('w-3.5 h-3.5', cfg.color)} />
          <span className={cn('text-xs font-semibold uppercase tracking-wider', cfg.color)}>{cfg.label}</span>
        </div>
        <div className="flex items-center gap-2">
          {bet.is_jackpot_eligible && (
            <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30 text-[9px] px-1.5 py-0">🏆 Jackpot</Badge>
          )}
          {isLocked && (
            <Badge variant="outline" className="text-emerald-400 border-emerald-400/30 text-[9px] px-1.5 py-0">🔐 On-Chain</Badge>
          )}
        </div>
      </div>

      <div className="p-4">
        <h3 className="font-semibold text-sm mb-1 line-clamp-2">{bet.markets?.question || bet.markets?.title}</h3>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-xs text-muted-foreground">Predicted:</span>
          <Badge variant="outline" className="text-xs">{predicted}</Badge>
        </div>

        <div className="grid grid-cols-3 gap-3 text-center">
          <div className="bg-muted/30 rounded-lg p-2">
            <p className="text-xs text-muted-foreground mb-0.5">Staked</p>
            <p className="text-sm font-bold">₦{bet.stake_tngn.toLocaleString()}</p>
          </div>
          {bet.status === 'won' && (
            <div className="bg-emerald-500/10 rounded-lg p-2">
              <p className="text-xs text-emerald-400 mb-0.5">Payout</p>
              <p className="text-sm font-bold text-emerald-400">₦{(bet.payout_tngn || 0).toLocaleString()}</p>
            </div>
          )}
          <div className={cn('rounded-lg p-2', profit >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10')}>
            <p className={cn('text-xs mb-0.5', profit >= 0 ? 'text-emerald-400' : 'text-red-400')}>P&L</p>
            <p className={cn('text-sm font-bold flex items-center justify-center gap-0.5', profit >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {profit >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {profit >= 0 ? '+' : ''}₦{Math.abs(profit).toLocaleString()}
            </p>
          </div>
        </div>

        {bet.is_first_bet_refunded && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            First Bet Insurance applied — stake refunded as credit
          </div>
        )}

        <div className="flex items-center justify-between mt-4">
          <span className="text-xs text-muted-foreground">
            {new Date(bet.placed_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
          <div className="flex gap-2">
            {isLocked && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs gap-1 px-2"
                onClick={() => onDownloadReceipt(bet.id)}
              >
                <Download className="w-3 h-3" />
                Receipt
              </Button>
            )}
            {bet.status === 'won' && (
              <Button
                size="sm"
                className="h-7 text-xs gap-1 px-2 bg-emerald-600 hover:bg-emerald-500"
                onClick={() => onShareCard(bet)}
              >
                <Share2 className="w-3 h-3" />
                Share
              </Button>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// Trader Card generator — canvas-based PNG for sharing
async function generateTraderCard(bet: Bet, username: string): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 340;
  const ctx = canvas.getContext('2d')!;

  // Background
  const grad = ctx.createLinearGradient(0, 0, 600, 340);
  grad.addColorStop(0, '#0a0e1a');
  grad.addColorStop(1, '#111827');
  ctx.fillStyle = grad;
  ctx.roundRect(0, 0, 600, 340, 16);
  ctx.fill();

  // Green accent line
  ctx.fillStyle = '#10b981';
  ctx.fillRect(0, 0, 4, 340);

  // Odds.ng logo text
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 14px monospace';
  ctx.fillText('ODDS.NG', 24, 36);
  ctx.fillStyle = '#6b7280';
  ctx.font = '11px monospace';
  ctx.fillText('VERIFIED PREDICTION RECEIPT', 24, 54);

  // Username
  ctx.fillStyle = '#9ca3af';
  ctx.font = '13px monospace';
  ctx.fillText(`@${username}`, 24, 90);

  // Market question
  ctx.fillStyle = '#f1f5f9';
  ctx.font = 'bold 18px sans-serif';
  const q = bet.markets?.question || '';
  const words = q.split(' ');
  let line = '';
  let y = 120;
  for (const word of words) {
    if (ctx.measureText(line + word).width > 552) {
      ctx.fillText(line, 24, y);
      line = word + ' ';
      y += 26;
    } else { line += word + ' '; }
    if (y > 170) { line = line.slice(0, -4) + '...'; break; }
  }
  ctx.fillText(line, 24, y);

  // Predicted
  const options = bet.markets?.options as string[] || [];
  ctx.fillStyle = '#6b7280';
  ctx.font = '12px monospace';
  ctx.fillText('PREDICTED', 24, 200);
  ctx.fillStyle = '#3b82f6';
  ctx.font = 'bold 16px monospace';
  ctx.fillText(options[bet.outcome_index] || 'Option ' + bet.outcome_index, 24, 220);

  // Divider
  ctx.strokeStyle = '#1f2937';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(24, 240);
  ctx.lineTo(576, 240);
  ctx.stroke();

  // Stats row
  const profit = (bet.payout_tngn || 0) - bet.stake_tngn;
  const stats = [
    { label: 'STAKED', value: `₦${bet.stake_tngn.toLocaleString()}`, color: '#f1f5f9' },
    { label: 'PAYOUT', value: `₦${(bet.payout_tngn || 0).toLocaleString()}`, color: '#10b981' },
    { label: 'PROFIT', value: `+₦${profit.toLocaleString()}`, color: '#10b981' },
  ];
  stats.forEach(({ label, value, color }, i) => {
    const x = 24 + i * 184;
    ctx.fillStyle = '#6b7280';
    ctx.font = '11px monospace';
    ctx.fillText(label, x, 265);
    ctx.fillStyle = color;
    ctx.font = 'bold 20px monospace';
    ctx.fillText(value, x, 290);
  });

  // Footer
  ctx.fillStyle = '#374151';
  ctx.font = '10px monospace';
  ctx.fillText(`${new Date(bet.placed_at).toLocaleDateString('en-NG')} • Polygon • I TOLD YOU SO`, 24, 324);

  return canvas.toDataURL('image/png');
}

export default function BetsPage() {
  const [session, setSession] = useState<any>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('active');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  const prevStatusRef = useRef<Map<string, Bet['status']>>(new Map());

  const fetchBets = useCallback(async () => {
    if (!session?.user?.id) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('user_bets')
        .select('*, markets(id, title, question, options, status, closes_at, merkle_root)')
        .eq('user_id', session.user.id)
        .order('placed_at', { ascending: false });

      if (error) throw error;
      const next = (data || []) as Bet[];

      // Detect any active → won transitions and celebrate
      let newlyWon = 0;
      for (const bet of next) {
        const prev = prevStatusRef.current.get(bet.id);
        if (prev && prev !== 'won' && bet.status === 'won') newlyWon++;
        prevStatusRef.current.set(bet.id, bet.status);
      }
      if (newlyWon > 0) {
        fireWinConfetti();
        toast({
          title: newlyWon === 1 ? '🎉 You won!' : `🎉 ${newlyWon} wins just landed!`,
          description: 'Head to the Won tab to generate your trader card.',
        });
      }

      setBets(next);
    } catch {
      toast({ title: 'Failed to load bets', variant: 'destructive' });
    } finally { setIsLoading(false); }
  }, [session?.user?.id, toast]);

  useEffect(() => { fetchBets(); }, [fetchBets]);

  // Realtime subscription to the user's bet updates — fires confetti on wins
  useEffect(() => {
    if (!session?.user?.id) return;
    const channel = supabase
      .channel(`bets:${session.user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_bets',
        filter: `user_id=eq.${session.user.id}`,
      }, () => { fetchBets(); })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, fetchBets]);

  const handleDownloadReceipt = async (betId: string) => {
    if (!session?.access_token) return;
    setDownloadingId(betId);
    try {
      const res = await fetch(`/api/receipt/merkle/${betId}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to generate receipt');
      }
      const receipt = await res.json();
      const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `oddsng-receipt-${betId.slice(0, 8)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Receipt downloaded', description: 'Keep this file safe — it proves your balance on-chain.' });
    } catch (err: any) {
      toast({ title: 'Receipt unavailable', description: err.message, variant: 'destructive' });
    } finally { setDownloadingId(null); }
  };

  const handleShareCard = async (bet: Bet) => {
    try {
      const { data: profile } = await supabase.from('users').select('username, first_name').eq('id', session.user.id).single();
      const username = profile?.username || profile?.first_name || 'Anon';
      const dataUrl = await generateTraderCard(bet, username);
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `oddsng-win-${bet.id.slice(0, 8)}.png`;
      a.click();
      toast({ title: 'Trader card saved!', description: 'Share it on Twitter or WhatsApp. Make them feel it.' });
    } catch {
      toast({ title: 'Could not generate card', variant: 'destructive' });
    }
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <Trophy className="w-12 h-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Sign in to see your bets</p>
        </div>
      </div>
    );
  }

  const active = bets.filter(b => b.status === 'active');
  const won = bets.filter(b => b.status === 'won');
  const lost = bets.filter(b => b.status === 'lost' || b.status === 'refunded');

  const tabs = [
    { id: 'active', label: 'Active', count: active.length, bets: active },
    { id: 'won', label: 'Won', count: won.length, bets: won },
    { id: 'lost', label: 'Lost', count: lost.length, bets: lost },
  ];

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Bets</h1>
          <p className="text-sm text-muted-foreground">{bets.length} total prediction{bets.length !== 1 ? 's' : ''}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchBets} className="text-muted-foreground">
          Refresh
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="grid w-full grid-cols-3 mb-6">
          {tabs.map(t => (
            <TabsTrigger key={t.id} value={t.id} className="gap-2">
              {t.label}
              {t.count > 0 && (
                <span className="bg-muted rounded-full px-1.5 py-0.5 text-xs font-semibold">{t.count}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>

        {tabs.map(t => (
          <TabsContent key={t.id} value={t.id}>
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(3)].map((_, i) => <div key={i} className="h-40 bg-muted/30 rounded-xl animate-pulse" />)}
              </div>
            ) : t.bets.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <AlertCircle className="w-10 h-10 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground">
                  {t.id === 'active' ? 'No active bets. Go make a prediction.' : `No ${t.id} bets yet.`}
                </p>
                {t.id === 'active' && (
                  <a href="/markets" className="mt-3">
                    <Button variant="outline" size="sm">Browse Markets</Button>
                  </a>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {t.bets.map(bet => (
                  <BetCard
                    key={bet.id}
                    bet={bet}
                    onDownloadReceipt={handleDownloadReceipt}
                    onShareCard={handleShareCard}
                  />
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
