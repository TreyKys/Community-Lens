'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2, Share2, Check, Link as LinkIcon, Sparkles } from 'lucide-react';
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

  const shareText = useMemo(() => {
    const handle = defaultUsername ? `@${defaultUsername.replace(/\s+/g, '').slice(0, 18)}` : 'I';
    return type === 'slip'
      ? `${handle === '@'+handle.slice(1) ? handle : 'I'} stacked a Multiplier on Opinions.ng. Stake the same call or make it yours →`
      : `${handle === '@'+handle.slice(1) ? handle : 'I'}'m calling it on Opinions.ng. Stake the same pick or make it yours →`;
  }, [defaultUsername, type]);

  const handleShare = async () => {
    setSharing(true);
    const payload = { title: 'My OPx Picks · Opinions.ng', text: shareText, url: shareUrl };
    try {
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share(payload);
        setSharing(false);
        return;
      }
    } catch {
      // user cancelled — fall through to clipboard
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

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-emerald-400" />
            Share your OPx Pick
          </DialogTitle>
          <DialogDescription>
            Pick a look, then drop the link on WhatsApp, X, or your status. Whoever taps it can stake the same call or make it theirs.
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

        {/* Live preview */}
        <div className="rounded-xl border border-border/50 overflow-hidden bg-card/30">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={cardUrl} alt="Card preview" className="w-full block" />
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
