'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Loader2, Info, ArrowRight, Sparkles, Layers, Wand2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { resolveTheme, type PicksThemeId } from '@/lib/picksThemes';

// When an invitee taps the share card, they land here. The page shows
// the same OG card inline, and a friendly modal with the two CTAs:
//
//   • Stake as is        — replicate the inviter's pick at the same
//                          stake and confirm. We stash the intent in
//                          localStorage and redirect to the relevant
//                          market (single) or the markets page with a
//                          slip-clone hint (multiplier). Auth gate:
//                          unauth visitors hit signup first; on
//                          completion the post-auth hook reads the
//                          stash and continues to the prefilled flow.
//
//   • Make It Yours      — same path but with editStake=true, so the
//                          bet modal / slip drawer opens in edit mode
//                          with the inviter's pick(s) but a blank
//                          stake the visitor types fresh. Surfaced
//                          under an info button per the spec.

interface PickDetails {
  type: 'bet' | 'slip';
  id: string;
  owner: { userId: string; handle: string };
  // For bet
  bet?: {
    marketId: number | string;
    outcomeIndex: number;
    stakeTngn: number;
    lockedOdds: number | null;
    status: string;
    payoutTngn: number | null;
  };
  market?: {
    id: number | string;
    question: string;
    options: string[];
    status: string;
    resolvedOutcome: number | null;
    pickLabel: string;
  };
  // For slip
  slip?: {
    stakeTngn: number;
    combinedOdds: number;
    payoutTngn: number;
    finalPayoutTngn: number | null;
    legsTotal: number;
    legsResolved: number;
    legsWon: number;
    status: string;
  };
  legs?: Array<{
    marketId: number | string;
    outcomeIndex: number;
    lockedOdds: number;
    realizedOdds: number | null;
    status: string;
    pickLabel: string;
    market: { id: number | string; question: string; status: string };
  }>;
}

const STAKE_INTENT_KEY = 'opx_stake_intent';

interface StakeIntent {
  type: 'bet' | 'slip';
  marketId?: number | string;
  outcomeIndex?: number;
  legs?: Array<{ marketId: number | string; outcomeIndex: number }>;
  stakeTngn: number;
  editStake: boolean;
  fromShareId: string;
}

export function PicksLandingClient({
  type, id, initialTheme,
}: { type: 'bet' | 'slip'; id: string; initialTheme: string | null }) {
  const router = useRouter();
  const [details, setDetails] = useState<PickDetails | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [editTipOpen, setEditTipOpen] = useState(false);

  const theme = resolveTheme(initialTheme);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/picks/${type}/${id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error || 'Pick not found');
        if (alive) setDetails(body);
      } catch (e: any) {
        if (alive) setLoadError(e?.message || 'Pick not found');
      }
    })();
    return () => { alive = false; };
  }, [type, id]);

  useEffect(() => {
    let alive = true;
    supabase.auth.getSession().then(({ data }) => {
      if (alive) setSignedIn(!!data.session);
    });
    return () => { alive = false; };
  }, []);

  const stash = (intent: StakeIntent) => {
    try { localStorage.setItem(STAKE_INTENT_KEY, JSON.stringify(intent)); } catch { /* private mode */ }
  };

  const buildIntent = (editStake: boolean): StakeIntent | null => {
    if (!details) return null;
    if (details.type === 'bet' && details.bet) {
      return {
        type: 'bet',
        marketId: details.bet.marketId,
        outcomeIndex: details.bet.outcomeIndex,
        stakeTngn: details.bet.stakeTngn,
        editStake,
        fromShareId: details.id,
      };
    }
    if (details.type === 'slip' && details.legs) {
      return {
        type: 'slip',
        legs: details.legs.map(l => ({ marketId: l.marketId, outcomeIndex: l.outcomeIndex })),
        stakeTngn: details.slip?.stakeTngn ?? 0,
        editStake,
        fromShareId: details.id,
      };
    }
    return null;
  };

  const handleStake = async (editStake: boolean) => {
    const intent = buildIntent(editStake);
    if (!intent) return;
    setBusy(true);

    if (!signedIn) {
      // Stash the intent so the post-auth hook can pick it back up
      // after signup, then trigger the existing open-auth event.
      stash(intent);
      try { window.dispatchEvent(new Event('opinionsng:open-auth')); } catch { /* no-op */ }
      setBusy(false);
      return;
    }

    // Signed in: stash + jump to the right surface. The markets page
    // (single) and slip drawer (multiplier) read the stash on mount and
    // pre-open with the legs/outcome pre-selected.
    stash(intent);
    if (intent.type === 'bet' && intent.marketId !== undefined) {
      router.push(`/markets?focus_market=${encodeURIComponent(String(intent.marketId))}&from_pick=1`);
    } else {
      router.push(`/markets?from_pick=1`);
    }
    setBusy(false);
  };

  if (loadError) {
    return (
      <div className="relative min-h-screen flex items-center justify-center p-4">
        <div className="text-center space-y-3 max-w-sm">
          <p className="text-lg font-semibold">Pick unavailable</p>
          <p className="text-sm text-muted-foreground">{loadError}</p>
          <Link href="/markets">
            <Button variant="outline" className="mt-2">Browse markets</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!details) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const cardUrl = `/api/picks-card/${type}/${id}${initialTheme ? `?theme=${encodeURIComponent(initialTheme)}` : ''}`;
  const isSlip = details.type === 'slip';
  const headline = isSlip
    ? `${details.slip?.legsTotal ?? details.legs?.length ?? 0}-leg Multiplier`
    : details.market?.question || 'Opinions.ng prediction';

  return (
    <div
      className="relative min-h-screen flex flex-col items-center p-4"
      style={{
        background: `linear-gradient(160deg, ${theme.gradient[0]}, ${theme.gradient[1]} 55%, ${theme.gradient[2]})`,
      }}
    >
      <div
        className="fixed inset-0 z-0 pointer-events-none opacity-50"
        style={{
          background: `radial-gradient(circle at 75% 18%, ${theme.glow}, transparent 60%)`,
        }}
      />

      <div className="relative z-10 w-full max-w-md space-y-5 py-8">
        <div className="text-center space-y-1.5">
          <p className="text-[10px] uppercase tracking-[0.3em] font-bold" style={{ color: theme.accent }}>
            OPx PICKS
          </p>
          <h1 className="text-xl font-bold" style={{ color: theme.fg }}>
            @{details.owner.handle} called it
          </h1>
          <p className="text-xs" style={{ color: theme.fgMuted }}>
            Predict and win — make this pick yours or stake as-is.
          </p>
        </div>

        {/* Inline card preview. img tag so we don't pay for a heavier
            Next/Image optimisation cycle on a viral landing. */}
        <div
          className="rounded-2xl overflow-hidden shadow-2xl"
          style={{ borderColor: `${theme.accent}40`, borderWidth: 1 }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cardUrl} alt={`@${details.owner.handle} OPx Picks`} className="w-full block" />
        </div>

        {/* Pick summary — what they're agreeing to stake on. */}
        <div
          className="rounded-xl p-3 space-y-2 border"
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderColor: `${theme.accent}33`,
          }}
        >
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-bold" style={{ color: theme.accent }}>
            {isSlip ? <Layers className="w-3 h-3" /> : <Sparkles className="w-3 h-3" />}
            <span>{isSlip ? `${details.legs?.length ?? 0}-leg Multiplier` : 'Single pick'}</span>
          </div>
          {!isSlip && details.market && (
            <>
              <p className="text-sm font-semibold whitespace-pre-wrap break-words" style={{ color: theme.fg }}>
                {details.market.question}
              </p>
              <p className="text-xs" style={{ color: theme.fgBody }}>
                Pick: <span className="font-bold" style={{ color: theme.accent }}>{details.market.pickLabel}</span>
                {details.bet?.lockedOdds ? ` · ${details.bet.lockedOdds.toFixed(2)}×` : ''}
              </p>
            </>
          )}
          {isSlip && details.legs && (
            <div className="space-y-1.5">
              {details.legs.map((l, i) => (
                <div key={i} className="text-xs flex items-start gap-2">
                  <span className="font-mono text-[10px] mt-0.5" style={{ color: theme.fgMuted }}>{i + 1}.</span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate" style={{ color: theme.fg }}>{l.market.question}</p>
                    <p className="text-[10px]" style={{ color: theme.fgBody }}>
                      Pick: <span style={{ color: theme.accent }}>{l.pickLabel}</span> · {l.lockedOdds.toFixed(2)}×
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between pt-2 mt-2 border-t" style={{ borderColor: `${theme.accent}22` }}>
            <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: theme.fgMuted }}>
              Original stake
            </span>
            <span className="text-sm font-bold tabular-nums" style={{ color: theme.fg }}>
              ₦{Math.round((isSlip ? details.slip?.stakeTngn : details.bet?.stakeTngn) || 0).toLocaleString()}
            </span>
          </div>
        </div>

        {/* CTAs */}
        <div className="space-y-2">
          <Button
            onClick={() => handleStake(false)}
            disabled={busy}
            className="w-full h-12 rounded-xl font-semibold text-base"
            style={{ background: theme.ctaBg, color: theme.ctaFg }}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
            Stake as is
            <ArrowRight className="w-4 h-4 ml-1" />
          </Button>

          <div className="relative">
            <Button
              variant="outline"
              onClick={() => handleStake(true)}
              disabled={busy}
              className="w-full h-11 rounded-xl font-semibold gap-2"
              style={{
                borderColor: `${theme.accent}60`,
                color: theme.fg,
                background: 'rgba(255,255,255,0.04)',
              }}
            >
              <Wand2 className="w-3.5 h-3.5" />
              Make It Yours
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setEditTipOpen(s => !s); }}
                className="ml-1 rounded-full p-0.5 hover:bg-white/10"
                aria-label="What does Make It Yours do?"
              >
                <Info className="w-3 h-3 opacity-70" />
              </button>
            </Button>
            {editTipOpen && (
              <div
                className="absolute z-20 left-0 right-0 mt-1.5 rounded-lg p-2.5 text-[11px] leading-relaxed shadow-xl"
                style={{
                  background: 'rgba(0,0,0,0.85)',
                  color: theme.fgBody,
                  border: `1px solid ${theme.accent}44`,
                }}
              >
                Clones the same {isSlip ? 'legs' : 'pick'} but lets you set a fresh stake before locking in.
              </div>
            )}
          </div>
        </div>

        <p className="text-[10px] text-center" style={{ color: theme.fgMuted }}>
          Not financial advice. 18+ only. Stakes are at your own risk.
        </p>
      </div>
    </div>
  );
}
