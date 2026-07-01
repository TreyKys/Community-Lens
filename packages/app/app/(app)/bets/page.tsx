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
  Trophy, AlertCircle, Target
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { POOL_RAKE_PCT } from '@/lib/displayPool';
import { SharePickModal } from '@/components/SharePickModal';

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
    total_pool: number | null;
    pool_by_outcome: Record<string, number> | null;
  };
}

// ── Multiplier slip shape ─────────────────────────────────────────────
// One row per parlay, plus its leg list with each leg's market joined in
// for a clean per-leg display. Status mirrors multiplier_slips.status:
// active = still live; won = all legs landed (paid); lost = a leg lost;
// voided = whole slip refunded (e.g. all legs voided). Loaded alongside
// single bets so the Picks page is one trip, not two.
interface SlipLeg {
  id: string;
  market_id: number;
  outcome_index: number;
  locked_odds: number;
  realized_odds: number | null;
  status: 'active' | 'won' | 'lost' | 'void';
  markets: {
    id: number;
    title: string | null;
    question: string;
    options: string[];
    status: string;
    closes_at: string;
    resolved_outcome: number | null;
  } | null;
}

interface Slip {
  id: string;
  slip_stake_tngn: number;
  net_slip_stake_tngn: number;
  combined_odds: number;
  effective_combined_odds: number;
  payout_tngn: number;
  final_payout_tngn: number | null;
  legs_total: number;
  legs_resolved: number;
  legs_won: number;
  status: 'active' | 'won' | 'lost' | 'voided';
  created_at: string;
  settled_at: string | null;
  multiplier_legs: SlipLeg[];
}

// Unified item type so the Live / Correct / Missed tabs can hold both
// kinds in placement-time order. The Picks page intentionally interleaves
// single bets and slips — users place both and want to see them in one
// chronological feed, not in two separate sections.
type FeedItem =
  | { kind: 'bet'; item: Bet; sortAt: string }
  | { kind: 'slip'; item: Slip; sortAt: string };

// Live "pot win" projection for an ACTIVE bet, using the current pool
// snapshot. Same math as lib/payout (pari-mutuel with 10% pool rake).
function projectActivePayout(bet: Bet): { payout: number; multiplier: number } | null {
  const pools = bet.markets?.pool_by_outcome;
  if (!pools || typeof pools !== 'object') return null;

  const winningPool = Number(pools[String(bet.outcome_index)] || 0);
  if (winningPool <= 0) return null;
  const totalPool = Object.values(pools).reduce((s: number, v: any) => s + Number(v || 0), 0);
  const losingPool = totalPool - winningPool;
  if (losingPool <= 0) return null; // void scenario

  const payoutPool = totalPool * (1 - POOL_RAKE_PCT);
  const share = bet.net_stake_tngn / winningPool;
  const payout = share * payoutPool;
  if (!Number.isFinite(payout) || payout <= 0) return null;
  return { payout, multiplier: payout / bet.stake_tngn };
}

function BetCard({ bet, onDownloadReceipt, onShareCard, onSharePick }: {
  bet: Bet;
  onDownloadReceipt: (betId: string) => void;
  onShareCard: (bet: Bet) => void;
  onSharePick: (betId: string) => void;
}) {
  const options = bet.markets?.options as string[] || [];
  const predicted = options[bet.outcome_index] || `Option ${bet.outcome_index}`;
  const isResolved = bet.status === 'won' || bet.status === 'lost';
  const profit = bet.status === 'won' ? (bet.payout_tngn || 0) - bet.stake_tngn : -bet.stake_tngn;
  const isLocked = bet.markets?.merkle_root != null;
  const closesAt = new Date(bet.markets?.closes_at);
  const isExpired = closesAt < new Date();

  const statusConfig = {
    active: { icon: Clock, color: 'text-blue-400', bg: 'bg-blue-500/10', border: 'border-blue-500/20', label: isExpired ? 'Awaiting Result' : 'Live' },
    won: { icon: CheckCircle2, color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Correct' },
    lost: { icon: XCircle, color: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/20', label: 'Missed' },
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

        <div className={cn('grid gap-3 text-center', isResolved ? 'grid-cols-3' : 'grid-cols-1')}>
          <div className="bg-muted/30 rounded-lg p-2">
            <p className="text-xs text-muted-foreground mb-0.5">Committed</p>
            <p className="text-sm font-bold">₦{bet.stake_tngn.toLocaleString()}</p>
          </div>
          {bet.status === 'won' && (
            <div className="bg-emerald-500/10 rounded-lg p-2">
              <p className="text-xs text-emerald-400 mb-0.5">Return</p>
              <p className="text-sm font-bold text-emerald-400">₦{(bet.payout_tngn || 0).toLocaleString()}</p>
            </div>
          )}
          {isResolved && (
            <div className={cn('rounded-lg p-2', profit >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10')}>
              <p className={cn('text-xs mb-0.5', profit >= 0 ? 'text-emerald-400' : 'text-red-400')}>P&L</p>
              <p className={cn('text-sm font-bold flex items-center justify-center gap-0.5', profit >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {profit >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {profit >= 0 ? '+' : ''}₦{Math.abs(profit).toLocaleString()}
              </p>
            </div>
          )}
        </div>

        {bet.is_first_bet_refunded && (
          <div className="mt-3 flex items-center gap-2 text-xs text-amber-400 bg-amber-500/10 rounded-lg px-3 py-2">
            <Shield className="w-3.5 h-3.5 shrink-0" />
            Protection applied — amount returned as credit
          </div>
        )}

        {bet.status === 'active' && (() => {
          const proj = projectActivePayout(bet);
          if (!proj) return null;
          return (
            <div className="mt-3 flex items-center justify-between bg-emerald-500/8 border border-emerald-500/20 rounded-lg px-3 py-2">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-emerald-300/90 font-semibold">
                <Target className="w-3 h-3" /> Projected Return
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-emerald-400 font-black text-base tabular-nums">
                  ₦{Math.round(proj.payout).toLocaleString()}
                </span>
                <span className="text-[10px] text-emerald-300/70 tabular-nums">
                  {proj.multiplier.toFixed(2)}×
                </span>
              </div>
            </div>
          );
        })()}

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
                Win card
              </Button>
            )}
            {/* OPx Picks — share the pick itself (any state). Generates
                a themed link instead of a downloaded PNG. */}
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1 px-2 border-emerald-500/40 text-emerald-300"
              onClick={() => onSharePick(bet.id)}
            >
              <Share2 className="w-3 h-3" />
              OPx Pick
            </Button>
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
  ctx.fillText('Opinions.ng', 100, 132);

  ctx.fillStyle = 'rgba(148, 163, 184, 0.85)';
  ctx.font = '500 18px system-ui, -apple-system, "Segoe UI", sans-serif';
  const eyebrow = won ? 'VERIFIED CALL — I TOLD YOU SO' : 'VERIFIED PREDICTION RECEIPT';
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
  const heroLabel = won ? 'PROFIT' : 'COMMITTED';
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
        { label: 'COMMITTED', value: `₦${bet.stake_tngn.toLocaleString()}` },
        { label: 'RETURN', value: `₦${(bet.payout_tngn || 0).toLocaleString()}` },
        { label: 'MULTIPLIER', value: bet.stake_tngn > 0 ? `${((bet.payout_tngn || 0) / bet.stake_tngn).toFixed(2)}×` : '—' },
      ]
    : [
        { label: 'STATUS', value: bet.status === 'lost' ? 'Missed' : bet.status === 'active' ? 'Live' : 'Refunded' },
        { label: 'RETURN', value: bet.payout_tngn ? `₦${bet.payout_tngn.toLocaleString()}` : '—' },
        { label: 'COMMITTED', value: `₦${bet.stake_tngn.toLocaleString()}` },
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
  ctx.fillText(`${datePart}  ·  Settled on Polygon  ·  Opinions.ng`, 72, 1032);

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

// ── Multiplier slip card ──────────────────────────────────────────────
// Displays a parlay's status, leg list, stake, and projected/actual
// payout. Mirrors the visual hierarchy of BetCard (status banner →
// title → stake/projection → footer) so the two card types feel like
// part of one feed.
function SlipCard({ slip, onSharePick }: { slip: Slip; onSharePick: (slipId: string) => void }) {
  const legs = slip.multiplier_legs || [];
  const isResolved = slip.status === 'won' || slip.status === 'lost' || slip.status === 'voided';
  const finalPayout = slip.final_payout_tngn ?? slip.payout_tngn;
  const profit = slip.status === 'won'  ? finalPayout - slip.slip_stake_tngn
              : slip.status === 'lost' ? -slip.slip_stake_tngn
              : 0;

  const statusConfig: Record<Slip['status'], {
    icon: typeof Clock; color: string; bg: string; border: string; label: string;
  }> = {
    active:  { icon: Clock,         color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/20',    label: `Live · ${slip.legs_resolved}/${slip.legs_total} legs in` },
    won:     { icon: CheckCircle2,  color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20', label: 'Multiplier hit' },
    lost:    { icon: XCircle,       color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20',     label: 'Multiplier missed' },
    voided:  { icon: Shield,        color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20',   label: 'Refunded (all-void)' },
  };
  const cfg = statusConfig[slip.status];
  const Icon = cfg.icon;

  // Projected payout at placement. When still active we show
  // payout_tngn (which already reflects the slip cap); after settle we
  // show final_payout_tngn.
  const projectedPayout = isResolved ? finalPayout : slip.payout_tngn;

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
          <span className={cn('text-xs font-semibold uppercase tracking-wider', cfg.color)}>
            {cfg.label}
          </span>
        </div>
        <Badge variant="outline" className="text-purple-300 border-purple-400/30 text-[9px] px-1.5 py-0">
          MULTIPLIER · {slip.legs_total}-LEG
        </Badge>
      </div>

      <div className="p-4 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-sm font-semibold">{slip.combined_odds.toFixed(2)}× combined</p>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            Placed {new Date(slip.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}
          </p>
        </div>

        <div className="rounded-md border border-border/50 divide-y divide-border/50">
          {legs.map((leg, idx) => {
            const opts = leg.markets?.options as string[] | undefined;
            const pickLabel = opts?.[leg.outcome_index] ?? `Outcome ${leg.outcome_index}`;
            const legStatus = leg.status;
            const legIcon = legStatus === 'won' ? CheckCircle2
                          : legStatus === 'lost' ? XCircle
                          : legStatus === 'void' ? Shield
                          : Clock;
            const legColor = legStatus === 'won' ? 'text-emerald-400'
                           : legStatus === 'lost' ? 'text-red-400'
                           : legStatus === 'void' ? 'text-amber-400'
                           : 'text-muted-foreground';
            const LegIcon = legIcon;
            return (
              <div key={leg.id} className="flex items-start gap-2 px-2.5 py-2">
                <LegIcon className={cn('w-3 h-3 mt-0.5 shrink-0', legColor)} />
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium truncate">
                    {leg.markets?.title || leg.markets?.question || `Market #${leg.market_id}`}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">
                    Pick: {pickLabel} · {Number(leg.locked_odds).toFixed(2)}×
                  </p>
                </div>
                <span className={cn('text-[10px] font-semibold uppercase tracking-wider', legColor)}>
                  {legStatus === 'void' ? 'Void' : legStatus}
                </span>
              </div>
            );
          })}
          {legs.length === 0 && (
            <p className="text-[11px] text-muted-foreground px-2.5 py-2">
              Leg details unavailable — refresh in a moment.
            </p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stake</p>
            <p className="text-sm font-bold tabular-nums">₦{Math.round(slip.slip_stake_tngn).toLocaleString()}</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {isResolved ? (slip.status === 'won' ? 'Paid' : slip.status === 'voided' ? 'Refunded' : 'Lost') : 'If correct'}
            </p>
            <p className={cn('text-sm font-bold tabular-nums',
              slip.status === 'won' ? 'text-emerald-400' :
              slip.status === 'lost' ? 'text-muted-foreground' :
              'text-foreground'
            )}>
              ₦{Math.round(slip.status === 'voided' ? slip.slip_stake_tngn : projectedPayout).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">P/L</p>
            <p className={cn('text-sm font-bold tabular-nums',
              profit > 0 ? 'text-emerald-400' :
              profit < 0 ? 'text-red-400' :
              'text-muted-foreground'
            )}>
              {isResolved && slip.status !== 'voided' ? (profit >= 0 ? '+' : '') + `₦${Math.round(profit).toLocaleString()}` : '—'}
            </p>
          </div>
        </div>

        {/* OPx Picks share button — same flow as singles, themed
            preview, hotlinked landing. */}
        <div className="pt-1 flex justify-end">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 px-2 border-violet-500/40 text-violet-300"
            onClick={() => onSharePick(slip.id)}
          >
            <Share2 className="w-3 h-3" />
            Share as OPx Pick
          </Button>
        </div>
      </div>
    </motion.div>
  );
}

export default function BetsPage() {
  const [session, setSession] = useState<any>(null);
  const [bets, setBets] = useState<Bet[]>([]);
  const [slips, setSlips] = useState<Slip[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('active');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  // OPx Picks — modal target. Set when the user taps "Share OPx Pick"
  // on any bet/slip card. Reset to null when the modal closes.
  const [pickShare, setPickShare] = useState<{ type: 'bet' | 'slip'; id: string } | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  // Pull the username once per session so the share modal can prefill
  // the share-sheet text ("@cleo is calling it on Opinions.ng…").
  useEffect(() => {
    if (!session?.user?.id) { setUsername(null); return; }
    let alive = true;
    supabase.from('users').select('username, first_name').eq('id', session.user.id).maybeSingle()
      .then(({ data }) => {
        if (alive) setUsername((data?.username || data?.first_name || null) as string | null);
      });
    return () => { alive = false; };
  }, [session?.user?.id]);

  const prevStatusRef = useRef<Map<string, Bet['status']>>(new Map());

  const fetchBets = useCallback(async () => {
    if (!session?.user?.id) return;
    setIsLoading(true);
    try {
      // Fetch through our own server-side /api/user/picks endpoint
      // instead of supabase-js directly. Reason: the client-side query
      // was silently returning stale slip data after resolution — most
      // plausibly because of Netlify edge / PostgREST caching layers we
      // don't fully control from the client. The server endpoint uses
      // service_role, sets force-no-store, and appends a cache-buster
      // query string so nothing between us and the DB can serve a
      // cached copy of a resolved slip's old 'active' status.
      const res = await fetch(`/api/user/picks?_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      if (!res.ok) throw new Error(`picks fetch failed: ${res.status}`);
      const payload = await res.json();

      const nextBets = (payload.bets || []) as Bet[];
      const nextSlips = (payload.slips || []) as unknown as Slip[];

      // Detect active → won transitions across BOTH singles and slips.
      // Slips share the same prevStatusRef map keyed by id — bet ids
      // are uuid, slip ids are uuid, no collision risk.
      let newlyWon = 0;
      for (const bet of nextBets) {
        const prev = prevStatusRef.current.get(bet.id);
        if (prev && prev !== 'won' && bet.status === 'won') newlyWon++;
        prevStatusRef.current.set(bet.id, bet.status);
      }
      for (const slip of nextSlips) {
        const prev = prevStatusRef.current.get(slip.id);
        if (prev && prev !== 'won' && slip.status === 'won') newlyWon++;
        prevStatusRef.current.set(slip.id, slip.status as any);
      }
      if (newlyWon > 0) {
        fireWinConfetti();
        toast({
          title: newlyWon === 1 ? '🎉 You called it!' : `🎉 ${newlyWon} correct calls just landed!`,
          description: 'Head to the Correct tab to generate your prediction card.',
        });
      }

      setBets(nextBets);
      setSlips(nextSlips);
    } catch {
      toast({ title: 'Failed to load predictions', variant: 'destructive' });
    } finally { setIsLoading(false); }
  }, [session?.user?.id, toast]);

  useEffect(() => { fetchBets(); }, [fetchBets]);

  // Realtime subscriptions to the user's bet AND slip updates — fires
  // confetti on wins regardless of product. Two distinct postgres_changes
  // bindings on a single channel so we don't pay for two websockets.
  useEffect(() => {
    if (!session?.user?.id) return;
    const channel = supabase
      .channel(`picks:${session.user.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'user_bets',
        filter: `user_id=eq.${session.user.id}`,
      }, () => { fetchBets(); })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'multiplier_slips',
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
      toast({ title: 'Prediction card saved!', description: 'Share it on Twitter or WhatsApp. Make them feel it.' });
    } catch {
      toast({ title: 'Could not generate card', variant: 'destructive' });
    }
  };

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center space-y-3">
          <Trophy className="w-12 h-12 text-muted-foreground mx-auto" />
          <p className="text-muted-foreground">Sign in to see your predictions</p>
        </div>
      </div>
    );
  }

  // Build a unified feed of bets + slips, sorted by placement time
  // descending so a freshly-placed slip lands at the top of Live, where
  // the user expects to find it. Slips and bets coexist in the same tab
  // because users place both kinds in the same session and don't think
  // of them as separate inventories.
  const allItems: FeedItem[] = [
    ...bets.map<FeedItem>(b => ({ kind: 'bet', item: b, sortAt: b.placed_at })),
    ...slips.map<FeedItem>(s => ({ kind: 'slip', item: s, sortAt: s.created_at })),
  ].sort((a, b) => b.sortAt.localeCompare(a.sortAt));

  const isLive    = (it: FeedItem) => it.item.status === 'active';
  const isWon     = (it: FeedItem) => it.item.status === 'won';
  // Missed bucket catches anything resolved-but-not-won: lost, refunded
  // (singles), voided (slips). Refunded/voided keep their own status
  // badge so the user can tell at a glance they got their stake back.
  const isMissed  = (it: FeedItem) =>
    it.item.status === 'lost' ||
    (it.kind === 'bet' && it.item.status === 'refunded') ||
    (it.kind === 'slip' && it.item.status === 'voided');

  const active = allItems.filter(isLive);
  const won    = allItems.filter(isWon);
  const lost   = allItems.filter(isMissed);

  const tabs = [
    { id: 'active', label: 'Live', count: active.length, items: active },
    { id: 'won', label: 'Correct', count: won.length, items: won },
    { id: 'lost', label: 'Missed', count: lost.length, items: lost },
  ];

  return (
    <div className="max-w-2xl mx-auto p-4 sm:p-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Predictions</h1>
          <p className="text-sm text-muted-foreground">
            {allItems.length} total prediction{allItems.length !== 1 ? 's' : ''}
            {slips.length > 0 && <> · {slips.length} Multiplier{slips.length !== 1 ? 's' : ''}</>}
          </p>
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
            ) : t.items.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <AlertCircle className="w-10 h-10 text-muted-foreground/50 mb-3" />
                <p className="text-muted-foreground">
                  {t.id === 'active' ? 'No live predictions. Make your first call.' : `No ${t.label.toLowerCase()} predictions yet.`}
                </p>
                {t.id === 'active' && (
                  <a href="/markets" className="mt-3">
                    <Button variant="outline" size="sm">Browse Markets</Button>
                  </a>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {t.items.map(it => (
                  it.kind === 'slip' ? (
                    <SlipCard
                      key={`slip-${it.item.id}`}
                      slip={it.item}
                      onSharePick={(slipId) => setPickShare({ type: 'slip', id: slipId })}
                    />
                  ) : (
                    <BetCard
                      key={`bet-${it.item.id}`}
                      bet={it.item}
                      onDownloadReceipt={handleDownloadReceipt}
                      onShareCard={handleShareCard}
                      onSharePick={(betId) => setPickShare({ type: 'bet', id: betId })}
                    />
                  )
                ))}
              </div>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* OPx Picks share modal — theme picker + live preview + native
          share. Lifted to the page so a single instance handles every
          card's share request. */}
      {pickShare && (
        <SharePickModal
          open={pickShare !== null}
          onClose={() => setPickShare(null)}
          type={pickShare.type}
          id={pickShare.id}
          defaultUsername={username}
        />
      )}
    </div>
  );
}
