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
// post-bet share modal, but reads /api/picks-card/preview/bet (no DB
// row yet). Lets the user pick a theme + see exactly what their card
// will look like before they tap Lock Prediction. After the bet
// places, the real SharePickModal auto-opens with the actual bet id.

const THEME_KEY = 'opx_picks_theme';

interface Props {
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

export function PickPreviewModal({
  open, onClose, marketId, outcomeIndex, stakeTngn, odds, handle,
}: Props) {
  const [theme, setTheme] = useState<PicksThemeId>(DEFAULT_PICKS_THEME);

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

  const ready =
    marketId !== null && marketId !== '' &&
    outcomeIndex !== null && Number.isFinite(outcomeIndex) &&
    stakeTngn > 0;

  const q = new URLSearchParams({
    marketId: String(marketId ?? ''),
    outcomeIndex: String(outcomeIndex ?? ''),
    stakeTngn: String(Math.round(stakeTngn || 0)),
    odds: String(odds || 0),
    handle: String(handle || 'predictor'),
    theme,
  });
  const previewUrl = `/api/picks-card/preview/bet?${q.toString()}`;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            Preview your OPx Pick
          </DialogTitle>
          <DialogDescription>
            This is what your share card will look like the moment you lock the prediction.
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
              Pick an option and enter a stake to preview the card.
            </div>
          )}
        </div>

        <p className="text-[10px] text-center text-muted-foreground">
          We&rsquo;ll open the real share sheet right after you lock this prediction.
        </p>
      </DialogContent>
    </Dialog>
  );
}
