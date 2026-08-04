'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Sparkles, Share2, Download, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  PICKS_THEME_LIST,
  DEFAULT_PICKS_THEME,
  type PicksThemeId,
} from '@/lib/picksThemes';

// Pre-bet OPx Pick preview. Renders the same OG card art as the
// post-bet share modal, but reads /api/picks-card/preview/bet (single
// bet) or /api/picks-card/preview/slip (multiplier) — no DB row yet.
// Lets the user pick a theme, see exactly what the card looks like,
// AND actually share or download it before ever placing the
// prediction — calling a shot shouldn't require staking on it. There's
// no public /p/[type]/[id] link yet (nothing's in the DB), so sharing
// here always attaches the image itself rather than a URL; placing the
// bet/slip afterwards still auto-opens the real SharePickModal, which
// additionally carries a shareable link back to the real pick.

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
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [displayedUrl, setDisplayedUrl] = useState('');
  const [imgLoading, setImgLoading] = useState(true);
  const { toast } = useToast();
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
  let baseParams = new URLSearchParams();

  if (isSlip) {
    const slip = props as SlipProps;
    ready = slip.legs.length >= 2 && slip.stakeTngn > 0;
    const legsParam = slip.legs
      .map(l => `${l.marketId}:${l.outcomeIndex}${l.lockedOdds ? `:${l.lockedOdds.toFixed(2)}` : ''}`)
      .join(',');
    baseParams = new URLSearchParams({
      legs: legsParam,
      stakeTngn: String(Math.round(stakeTngn || 0)),
      odds: String(odds || 0),
      handle: String(handle || 'predictor'),
    });
  } else {
    const bet = props as BetProps;
    ready =
      bet.marketId !== null && bet.marketId !== '' &&
      bet.outcomeIndex !== null && Number.isFinite(bet.outcomeIndex) &&
      bet.stakeTngn > 0;
    baseParams = new URLSearchParams({
      marketId: String(bet.marketId ?? ''),
      outcomeIndex: String(bet.outcomeIndex ?? ''),
      stakeTngn: String(Math.round(stakeTngn || 0)),
      odds: String(odds || 0),
      handle: String(handle || 'predictor'),
    });
  }

  const previewBasePath = isSlip ? '/api/picks-card/preview/slip' : '/api/picks-card/preview/bet';
  const baseQuery = baseParams.toString();
  const previewUrl = `${previewBasePath}?${baseQuery}&theme=${theme}`;

  // Smooth swap — preload the target image before showing it, so the
  // preview never blanks/flashes as the theme (or the underlying stake/
  // picks) changes.
  useEffect(() => {
    if (!ready) { setDisplayedUrl(''); return; }
    let cancelled = false;
    setImgLoading(true);
    const img = new Image();
    const settle = () => { if (!cancelled) { setDisplayedUrl(previewUrl); setImgLoading(false); } };
    img.onload = settle;
    img.onerror = settle; // still swap so a real failure surfaces instead of freezing on a stale frame
    img.src = previewUrl;
    return () => { cancelled = true; };
  }, [previewUrl, ready]);

  // Warm the cache for other themes once the inputs settle — debounced
  // (so typing a stake doesn't fire requests per keystroke) AND loaded
  // one at a time, so the preloads never starve the visible card the
  // user is waiting on (firing all six at once used to leave it stuck).
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const t = setTimeout(() => {
      let i = 0;
      const next = () => {
        if (cancelled || i >= PICKS_THEME_LIST.length) return;
        const img = new Image();
        const advance = () => { i += 1; next(); };
        img.onload = advance;
        img.onerror = advance;
        img.src = `${previewBasePath}?${baseQuery}&theme=${PICKS_THEME_LIST[i].id}`;
      };
      next();
    }, 700);
    return () => { cancelled = true; clearTimeout(t); };
  }, [ready, previewBasePath, baseQuery]);

  const cardFileName = 'opinions-ng-pick-preview.png';
  const shareText = isSlip
    ? `Calling it: a ${(props as SlipProps).legs.length}-leg Multiplier on Opinions.ng`
    : 'Calling my pick on Opinions.ng';

  const fetchPreviewBlob = async (): Promise<Blob> => {
    const res = await fetch(previewUrl);
    if (!res.ok) throw new Error(`Card image failed to load (${res.status})`);
    return res.blob();
  };

  // No /p/[type]/[id] link exists yet — nothing's placed, so there's no
  // DB row to link to. Sharing here always attaches the image itself;
  // there's no link-only fallback the way the post-placement share has.
  const handleShare = async () => {
    setSharing(true);
    try {
      const blob = await fetchPreviewBlob();
      const file = new File([blob], cardFileName, { type: 'image/png' });
      if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'My OPx Pick · Opinions.ng', text: shareText, files: [file] });
        setSharing(false);
        return;
      }
      // File-sharing unsupported (mainly desktop) — download is the
      // only thing that makes sense without a link to fall back to.
      await handleDownload();
    } catch (e: any) {
      if (e?.name === 'AbortError') { setSharing(false); return; } // user cancelled the share sheet
      toast({ title: 'Could not share', description: e.message, variant: 'destructive' });
    }
    setSharing(false);
  };

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await fetchPreviewBlob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = cardFileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      setCopied(true);
      toast({ title: 'Image saved', description: 'Share it anywhere — no need to place the pick first.' });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: 'Could not download image', variant: 'destructive' });
    }
    setDownloading(false);
  };

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

        <div className="relative rounded-xl border border-border/50 overflow-hidden bg-card/30 min-h-[200px] flex items-center justify-center">
          {ready && displayedUrl ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={displayedUrl} alt="Pick preview" className="w-full block" />
              {imgLoading && (
                <div className="absolute top-2 right-2 bg-black/40 backdrop-blur-sm rounded-full p-1.5">
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center justify-center py-10 text-sm text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              {isSlip
                ? 'Add at least 2 picks and a stake to preview the card.'
                : 'Pick an option and enter a stake to preview the card.'}
            </div>
          )}
        </div>

        {ready && (
          <div className="flex flex-col gap-2">
            <Button
              onClick={handleShare}
              disabled={sharing}
              className="w-full h-11 rounded-xl font-semibold bg-emerald-500 hover:bg-emerald-400 text-black"
            >
              {sharing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Share2 className="w-4 h-4 mr-2" />}
              Share this pick
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDownload}
              disabled={downloading}
              className="w-full h-10 rounded-xl gap-2"
            >
              {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : copied ? <Check className="w-3.5 h-3.5" /> : <Download className="w-3.5 h-3.5" />}
              Download image
            </Button>
          </div>
        )}

        <p className="text-[10px] text-center text-muted-foreground">
          {isSlip ? 'Placing this Multiplier' : 'Locking this prediction'} afterwards also unlocks a shareable link back to the real pick.
        </p>
      </DialogContent>
    </Dialog>
  );
}
