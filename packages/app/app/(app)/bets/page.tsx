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

// Trader Card generator — high-DPI 1080x1080 PNG for social sharing.
// Square format renders cleanly on Twitter/X, WhatsApp status, IG feed, Threads.
async function generateTraderCard(bet: Bet, username: string): Promise<string> {
  const SIZE = 1080;
  const dpr = Math.max(2, Math.min(3, typeof window !== 'undefined' ? window.devicePixelRatio || 2 : 2));
  const canvas = document.createElement('canvas');
  canvas.width = SIZE * dpr;
  canvas.height = SIZE * dpr;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.textBaseline = 'alphabetic';
  // Anti-alias fonts crisply
  if ('imageSmoothingEnabled' in ctx) ctx.imageSmoothingEnabled = true;

  // ── Background — deep navy gradient with subtle vignette ─────────
  const bg = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  bg.addColorStop(0, '#0b1220');
  bg.addColorStop(0.55, '#0a0e1a');
  bg.addColorStop(1, '#050810');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // Diagonal emerald glow (top-left)
  const glow = ctx.createRadialGradient(120, 120, 60, 120, 120, 720);
  glow.addColorStop(0, 'rgba(16, 185, 129, 0.18)');
  glow.addColorStop(1, 'rgba(16, 185, 129, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SIZE, SIZE);

  // ── Header — brand mark + "verified prediction" eyebrow ──────────
  const won = bet.status === 'won';
  const accent = won ? '#10b981' : '#ef4444';

  // Accent bar
  ctx.fillStyle = accent;
  ctx.fillRect(72, 96, 6, 64);

  ctx.fillStyle = '#ffffff';
  ctx.font = '700 36px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText('Odds.ng', 100, 132);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.font = '500 18px system-ui, -apple-system, "Segoe UI", sans-serif';
  const eyebrow = won ? 'VERIFIED WIN — I TOLD YOU SO' : 'VERIFIED PREDICTION RECEIPT';
  ctx.fillText(eyebrow, 100, 158);

  // ── User badge (top-right) ───────────────────────────────────────
  ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
  roundRect(ctx, SIZE - 320, 96, 248, 56, 28);
  ctx.fill();
  ctx.fillStyle = '#f1f5f9';
  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(`@${username}`, SIZE - 196, 132);
  ctx.textAlign = 'left';

  // ── Market question — large, two-line max ────────────────────────
  const q = (bet.markets?.question || '').trim();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 44px system-ui, -apple-system, "Segoe UI", sans-serif';
  const qLines = wrapLines(ctx, q, SIZE - 144, 2);
  let qy = 280;
  for (const line of qLines) {
    ctx.fillText(line, 72, qy);
    qy += 56;
  }

  // ── Predicted outcome chip ───────────────────────────────────────
  const options = (bet.markets?.options as string[]) || [];
  const predicted = options[bet.outcome_index] || `Option ${bet.outcome_index}`;
  ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
  const chipY = qy + 24;
  const chipText = `Picked: ${predicted}`;
  ctx.font = '600 24px system-ui, -apple-system, sans-serif';
  const chipW = Math.min(SIZE - 144, ctx.measureText(chipText).width + 56);
  roundRect(ctx, 72, chipY, chipW, 56, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(59, 130, 246, 0.45)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, 72, chipY, chipW, 56, 28);
  ctx.stroke();
  ctx.fillStyle = '#93c5fd';
  ctx.fillText(chipText, 100, chipY + 36);

  // ── HERO — the win/loss number ───────────────────────────────────
  const profit = (bet.payout_tngn || 0) - bet.stake_tngn;
  const heroLabel = won ? 'PROFIT' : 'STAKED';
  const heroValue = won ? `+₦${profit.toLocaleString()}` : `₦${bet.stake_tngn.toLocaleString()}`;

  ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
  ctx.font = '600 22px system-ui, -apple-system, sans-serif';
  ctx.fillText(heroLabel, 72, 660);

  ctx.fillStyle = accent;
  ctx.font = '900 156px system-ui, -apple-system, "Segoe UI", sans-serif';
  ctx.fillText(heroValue, 72, 800);

  // ── Stats row (3-up) ─────────────────────────────────────────────
  const stats: { label: string; value: string }[] = won
    ? [
        { label: 'STAKED', value: `₦${bet.stake_tngn.toLocaleString()}` },
        { label: 'PAYOUT', value: `₦${(bet.payout_tngn || 0).toLocaleString()}` },
        { label: 'MULTIPLIER', value: bet.stake_tngn > 0 ? `${((bet.payout_tngn || 0) / bet.stake_tngn).toFixed(2)}×` : '—' },
      ]
    : [
        { label: 'STATUS', value: bet.status === 'lost' ? 'Lost' : bet.status === 'active' ? 'Live' : 'Refunded' },
        { label: 'PAYOUT', value: bet.payout_tngn ? `₦${bet.payout_tngn.toLocaleString()}` : '—' },
        { label: 'STAKED', value: `₦${bet.stake_tngn.toLocaleString()}` },
      ];

  // Stats panel background
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  roundRect(ctx, 72, 856, SIZE - 144, 132, 20);
  ctx.fill();

  const colW = (SIZE - 144) / 3;
  stats.forEach(({ label, value }, i) => {
    const cx = 72 + i * colW + colW / 2;
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.7)';
    ctx.font = '600 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(label, cx, 894);
    ctx.fillStyle = '#f1f5f9';
    ctx.font = '700 36px system-ui, -apple-system, sans-serif';
    ctx.fillText(value, cx, 950);
  });
  ctx.textAlign = 'left';

  // ── Footer — date + chain marker ─────────────────────────────────
  ctx.fillStyle = 'rgba(100, 116, 139, 0.7)';
  ctx.font = '500 18px system-ui, -apple-system, sans-serif';
  const datePart = new Date(bet.placed_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });
  ctx.fillText(`${datePart}  ·  Settled on Polygon  ·  odds.ng`, 72, 1032);

  return canvas.toDataURL('image/png');
}

// Word-wrap utility for canvas text. Truncates with an ellipsis after maxLines.
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines - 1) break;
    } else {
      current = candidate;
    }
  }
  // Any remaining words — fit what we can on the last line, ellipsize the rest
  const remainingWords = words.slice(words.indexOf(current.split(' ').pop() || words[0]));
  if (lines.length < maxLines) {
    let last = current;
    let i = words.indexOf(remainingWords[remainingWords.length - 1]) + 1;
    while (i < words.length && ctx.measureText(`${last} ${words[i]}…`).width <= maxWidth) {
      last = `${last} ${words[i]}`;
      i++;
    }
    if (i < words.length) last = `${last}…`;
    lines.push(last);
  }
  return lines;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
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
