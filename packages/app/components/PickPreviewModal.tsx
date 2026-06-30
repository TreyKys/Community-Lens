'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Loader2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  PICKS_THEME_LIST,
  DEFAULT_PICKS_THEME,
  type PicksThemeId,
} from '@/lib/picksThemes';

// Pre-bet OPx Pick preview. Renders the same OG card art as the
// post-bet share modal, but reads /api/picks-card/preview/bet (single
// bet) or /api/picks-card/preview/slip (multiplier) — no DB row yet.
// Lets the user pick a theme + see exactly what their card will look
// like before they tap Lock Prediction / Place Multiplier. After the
// bet/slip places, the real SharePickModal auto-opens with the actual
// id.

const THEME_KEY = 'opx_picks_theme';

interface SlipLegInput {
  marketId: number;
  outcomeIndex: number;
  /** Optional locked-odds hint baked into the preview chip. */
  lockedOdds?: number;
}

interface BetProps {
  mode?: 'bet';
  open: boolean;
  onClose: () => void;
  marketId: number | string | null;
  outcomeIndex: number | null;
  stakeTngn: number;
  /** Frozen / projected multiplier — locked_odds preview for locked
   *  markets, or the parimutuel floor for the others. */
  odds: number;
  handle?: string | null;
}

interface SlipProps {
  mode: 'slip';
  open: boolean;
  onClose: () => void;
  legs: SlipLegInput[];
  stakeTngn: number;
  /** Combined odds from the live quote. */
  odds: number;
  handle?: string | null;
}

type Props = BetProps | SlipProps;

export function PickPreviewModal(props: Props) {
  const [theme, setTheme] = useState<PicksThemeId>(DEFAULT_PICKS_THEME);
  const { open, onClose, stakeTngn, odds, handle } = props;
  const isSlip = props.mode === 'slip';

  useEffect(() => {
    if (!open) return;
    try {
      const stored = localStorage.getItem(THEME_KEY) as PicksThemeId | null;
      if (stored && PICKS_THEME_LIST.some(t => t.id === stored)) setTheme(stored);
    } catch { /* no-op */ }
  }, [open]);

  useEffect(() => {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* no-op */ }
  }, [theme]);

  let ready = false;
  let previewUrl = '';

  if (isSlip) {
    const slip = props as SlipProps;
    ready = slip.legs.length >= 2 && slip.stakeTngn > 0;
    const legsParam = slip.legs
      .map(l => `${l.marketId}:${l.outcomeIndex}${l.lockedOdds ? `:${l.lockedOdds.toFixed(2)}` : ''}`)
      .join(',');
    const q = new URLSearchParams({
      legs: legsParam,
      stakeTngn: String(Math.round(stakeTngn || 0)),
      odds: String(odds || 0),
      handle: String(handle || 'predictor'),
      theme,
    });
    previewUrl = `/api/picks-card/preview/slip?${q.toString()}`;
  } else {
    const bet = props as BetProps;
    ready =
      bet.marketId !== null && bet.marketId !== '' &&
      bet.outcomeIndex !== null && Number.isFinite(bet.outcomeIndex) &&
      bet.stakeTngn > 0;
    const q = new URLSearchParams({
      marketId: String(bet.marketId ?? ''),
      outcomeIndex: String(bet.outcomeIndex ?? ''),
      stakeTngn: String(Math.round(stakeTngn || 0)),
      odds: String(odds || 0),
      handle: String(handle || 'predictor'),
      theme,
    });
    previewUrl = `/api/picks-card/preview/bet?${q.toString()}`;
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            Preview your OPx Pick
          </DialogTitle>
          <DialogDescription>
            {isSlip
              ? 'This is what your share card will look like the moment you place this Multiplier.'
              : 'This is what your share card will look like the moment you lock the prediction.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-muted-foreground">Theme</p>
          <div className="grid grid-cols-3 gap-2">
            {PICKS_THEME_LIST.map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTheme(t.id)}
                className={cn(
                  'rounded-lg p-2 border-2 transition-all text-left flex flex-col gap-1.5 hover:scale-[1.02]',
                  theme === t.id ? 'border-foreground/60' : 'border-transparent hover:border-border',
                )}
                aria-pressed={theme === t.id}
              >
                <div
                  className="h-10 rounded-md w-full"
                  style={{
                    background: `linear-gradient(135deg, ${t.gradient[0]}, ${t.gradient[1]}, ${t.gradient[2]})`,
                    boxShadow: `inset 0 0 24px ${t.glow}`,
                  }}
                />
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: t.accent }} />
                  <span className="text-[11px] font-medium truncate">{t.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-border/50 overflow-hidden bg-card/30 min-h-[200px] flex items-center justify-center">
          {ready ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={previewUrl} alt="Pick preview" className="w-full block" />
          ) : (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {isSlip
                ? 'Add at least 2 picks and a stake to preview the card.'
                : 'Pick an option and enter a stake to preview the card.'}
            </div>
          )}
        </div>

        <p className="text-[10px] text-center text-muted-foreground">
          We&rsquo;ll open the real share sheet right after you {isSlip ? 'place this Multiplier' : 'lock this prediction'}.
        </p>
      </DialogContent>
    </Dialog>
  );
}
