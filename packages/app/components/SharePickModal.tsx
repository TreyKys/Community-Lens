'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Share2, Check, Link as LinkIcon, Sparkles, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import {
  PICKS_THEME_LIST,
  DEFAULT_PICKS_THEME,
  type PicksThemeId,
} from '@/lib/picksThemes';

// Share modal triggered from the user's /bets ("Picks") page. Renders a
// theme swatch row, the live OG card preview, and a native share button
// with a clipboard fallback. The user's last theme pick is remembered in
// localStorage so the second share opens on the same look.
//
// Sharing a bare URL via navigator.share only ever produces a rich
// preview in chat/DM contexts that fetch OG tags (WhatsApp DM, X DM,
// iMessage) — WhatsApp Status, Snapchat, and X's Story/status compose
// surfaces do NOT fetch link previews at all; they need an actual image
// FILE. So handleShare always fetches the real PNG from the card
// endpoint first and, wherever the platform supports it (Web Share API
// Level 2 — most mobile browsers), attaches it as a file. Where file
// sharing isn't supported (desktop browsers mainly), a standalone
// "Download image" button guarantees the PNG is always obtainable so
// it can be attached by hand.

const THEME_KEY = 'opx_picks_theme';
const SITE_ORIGIN_FALLBACK = 'https://opinionsng.com';

export function SharePickModal({
  open, onClose, type, id, defaultUsername,
}: {
  open: boolean;
  onClose: () => void;
  type: 'bet' | 'slip';
  id: string;
  defaultUsername?: string | null;
}) {
  const { toast } = useToast();
  const [theme, setTheme] = useState<PicksThemeId>(DEFAULT_PICKS_THEME);
  const [copied, setCopied] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [displayedUrl, setDisplayedUrl] = useState('');
  const [imgLoading, setImgLoading] = useState(true);

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

  const origin = typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : SITE_ORIGIN_FALLBACK;
  const shareUrl = `${origin}/p/${type}/${id}?theme=${theme}`;
  const cardUrl = `/api/picks-card/${type}/${id}?theme=${theme}`;

  // Smooth theme swap — preload the new theme's PNG before swapping the
  // visible <img>, so switching never blanks/flashes while the new
  // render arrives. Combined with the route's Cache-Control (added
  // alongside this), a theme already viewed this session resolves from
  // cache almost immediately.
  useEffect(() => {
    let cancelled = false;
    setImgLoading(true);
    const img = new Image();
    const settle = () => { if (!cancelled) { setDisplayedUrl(cardUrl); setImgLoading(false); } };
    img.onload = settle;
    img.onerror = settle; // still swap so a real failure surfaces instead of freezing on a stale theme
    img.src = cardUrl;
    return () => { cancelled = true; };
  }, [cardUrl]);

  // Preload every theme's card the moment the modal opens. This is the
  // actual fix for "switching themes is stubborn and slow" — without
  // this, every single swatch click (even re-clicking one already
  // viewed) triggered a full fresh render with nothing cached anywhere.
  useEffect(() => {
    if (!open) return;
    const preloaders = PICKS_THEME_LIST.map(t => {
      const img = new Image();
      img.src = `/api/picks-card/${type}/${id}?theme=${t.id}`;
      return img;
    });
    return () => { preloaders.forEach(img => { img.onload = null; img.onerror = null; }); };
  }, [open, type, id]);

  const shareText = useMemo(() => {
    const handle = defaultUsername ? `@${defaultUsername.replace(/\s+/g, '').slice(0, 18)}` : 'I';
    return type === 'slip'
      ? `${handle === '@'+handle.slice(1) ? handle : 'I'} stacked a Multiplier on Opinions.ng. Stake the same call or make it yours →`
      : `${handle === '@'+handle.slice(1) ? handle : 'I'}'m calling it on Opinions.ng. Stake the same pick or make it yours →`;
  }, [defaultUsername, type]);

  const cardFileName = `opinions-ng-${type}-${id}.png`;

  const fetchCardBlob = async (): Promise<Blob> => {
    const res = await fetch(cardUrl);
    if (!res.ok) throw new Error(`Card image failed to load (${res.status})`);
    return res.blob();
  };

  const handleShare = async () => {
    setSharing(true);
    try {
      // Try to attach the actual PNG first — this is the only way the
      // card shows up as an image on WhatsApp Status, Snapchat, and X
      // Story surfaces (they don't fetch link previews). Falls through
      // to link-only sharing if the image can't be fetched or the
      // platform doesn't support file sharing.
      try {
        const blob = await fetchCardBlob();
        const file = new File([blob], cardFileName, { type: 'image/png' });
        if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
          await navigator.share({
            title: 'My OPx Picks · Opinions.ng',
            text: `${shareText}\n${shareUrl}`,
            files: [file],
          });
          setSharing(false);
          return;
        }
      } catch (e: any) {
        if (e?.name === 'AbortError') { setSharing(false); return; } // user cancelled the share sheet
        // image fetch failed or file-share unsupported — fall through
      }

      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title: 'My OPx Picks · Opinions.ng', text: shareText, url: shareUrl });
        setSharing(false);
        return;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') { setSharing(false); return; }
      // fall through to clipboard
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast({ title: 'Link copied — paste it anywhere.' });
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast({ title: 'Could not copy link', variant: 'destructive' });
    }
    setSharing(false);
  };

  // Standalone, always-available path to the actual image — for
  // desktop (no native share sheet) or anyone who'd rather attach the
  // file by hand to a Status/Story than rely on the share sheet's app
  // picker guessing right.
  const handleDownload = async () => {
    setDownloading(true);
    try {
      const blob = await fetchCardBlob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = cardFileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      toast({ title: 'Image saved', description: 'Attach it to your Status, Snap, or post.' });
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
            Share your OPx Pick
          </DialogTitle>
          <DialogDescription>
            Pick a look, then share it. For WhatsApp Status, Snapchat, or an X post, use{' '}
            <strong>Download image</strong> so the card actually appears — statuses and stories
            don&rsquo;t render link previews, only attached images.
          </DialogDescription>
        </DialogHeader>

        {/* Theme swatches */}
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
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: t.accent }}
                  />
                  <span className="text-[11px] font-medium truncate">{t.label}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Live preview — keeps showing the last-loaded theme while the
            next one loads in the background, so switching never blanks. */}
        <div className="relative rounded-xl border border-border/50 overflow-hidden bg-card/30 min-h-[200px]">
          {displayedUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={displayedUrl} alt="Card preview" className="w-full block" />
          )}
          {imgLoading && (
            <div className="absolute top-2 right-2 bg-black/40 backdrop-blur-sm rounded-full p-1.5">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <Button
            onClick={handleShare}
            disabled={sharing}
            className="w-full h-11 rounded-xl font-semibold bg-emerald-500 hover:bg-emerald-400 text-black"
          >
            {sharing ? <Loader2 className="w-4 h-4 animate-spin mr-2" />
              : copied ? <Check className="w-4 h-4 mr-2" />
              : <Share2 className="w-4 h-4 mr-2" />}
            {copied ? 'Copied!' : 'Share my pick'}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleDownload}
            disabled={downloading}
            className="w-full h-10 rounded-xl gap-2"
          >
            {downloading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
            Download image
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(shareUrl);
                setCopied(true);
                toast({ title: 'Link copied.' });
                setTimeout(() => setCopied(false), 1800);
              } catch {
                toast({ title: 'Copy failed', variant: 'destructive' });
              }
            }}
            className="w-full h-10 rounded-xl gap-2"
          >
            <LinkIcon className="w-3.5 h-3.5" />
            Copy link only
          </Button>
        </div>

        <p className="text-[10px] text-center text-muted-foreground">
          Cards are public — they show only your pick + handle, never your balance.
        </p>
      </DialogContent>
    </Dialog>
  );
}
