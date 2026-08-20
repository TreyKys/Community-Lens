'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

// Full-bleed hub backdrop that fades out as the page scrolls.
//
// The effect: the art is at full strength when you land, and dissolves as you
// scroll into the markets, so the page opens with atmosphere and then gets out
// of the way of the thing people came to read.
//
// PERFORMANCE — this is the constraint that shaped the implementation, not an
// afterthought. globals.css carries a note about a previous version of the
// site's backdrop: two large animated blurred radial gradients caused visible
// horizontal banding on Mali/Adreno GPUs (most Android devices in this
// market), because the rasteriser could not keep alpha stable across an
// animated transform. So this deliberately:
//
//   * animates ONLY opacity — a compositor-level property, no repaint, no
//     filter, no transform on the blurred layer;
//   * reads scroll in a passive listener and writes inside requestAnimationFrame,
//     so it never blocks the scroll thread or thrashes layout;
//   * writes opacity straight to the DOM node rather than through React state,
//     because re-rendering a tree on every scroll frame is how a smooth effect
//     becomes a janky one.
//
// Honours prefers-reduced-motion by pinning to a constant low opacity: the art
// still frames the page, it just does not move.

const FADE_OVER_PX = 420;   // roughly one phone-screen of scroll
const MIN_OPACITY = 0.06;   // never fully gone — keeps the page from feeling flat

export function ScrollFadeBackdrop({ gradient, imageUrl, alt }: {
  gradient: [string, string];
  imageUrl?: string;
  alt?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Photo failures are silent by design: the CSS art underneath is a complete
  // backdrop on its own, so a dead URL degrades to "no photo" rather than to a
  // broken-image icon over an empty page.
  const [imageOk, setImageOk] = useState(true);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      el.style.opacity = '0.5';
      return;
    }

    let frame = 0;
    const apply = () => {
      frame = 0;
      const y = window.scrollY || 0;
      const t = Math.min(1, Math.max(0, y / FADE_OVER_PX));
      el.style.opacity = String(MIN_OPACITY + (1 - MIN_OPACITY) * (1 - t));
    };
    const onScroll = () => {
      // Coalesce: several scroll events per frame collapse into one write.
      if (!frame) frame = window.requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      // z-0, NOT a negative z-index. (app)/layout.tsx wraps page content in a
      // div carrying an opaque `bg-background`, and CSS paints negative
      // z-index descendants BEHIND the backgrounds of in-flow blocks — so a
      // -z-10 backdrop here is invisible, with no error to hint at why. The
      // root layout's .opinions-bg gets away with z-index:-1 because it sits
      // directly under <body> with no opaque wrapper above it.
      //
      // md:left-64 clears the desktop sidebar (w-64). Without it a z-0 fixed
      // layer would paint over the nav, since the sidebar is in-flow.
      className="fixed inset-0 md:left-64 z-0 pointer-events-none will-change-[opacity]"
    >
      {imageUrl && imageOk && (
        // The art is 16:9. A phone viewport is roughly 1:2, so stretching it
        // to `inset-0` and letting object-cover fill would scale it up by
        // height and throw away ~60% of the width — the wide arena shot, which
        // is the entire point of the composition, becomes an unrecognisable
        // zoomed crop.
        //
        // So on mobile it keeps its own band at the top of the screen at close
        // to native ratio, and fades into the page below. On desktop, where
        // the viewport is already near 16:9, it fills normally.
        <div className="absolute inset-x-0 top-0 h-[70vw] md:h-full">
          <Image
            src={imageUrl}
            alt={alt || ''}
            fill
            priority
            unoptimized
            sizes="100vw"
            className="object-cover object-center"
            onError={() => setImageOk(false)}
          />
          {/* Softens the bottom edge of that band. Only needed on mobile —
              on desktop the band is the full viewport, so there is no edge
              mid-screen to hide. */}
          <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-background md:hidden" />
        </div>
      )}

      {/* Gradient art — two jobs depending on whether a photo loaded.

          NO PHOTO: this IS the backdrop, at full strength.

          PHOTO: it drops to a faint tint. The hub art is already graded to
          the brand emerald, so laying a full-strength per-sport gradient
          (orange for basketball, violet for esports) over the top fights the
          photograph and turns it muddy instead of tinting it. At low opacity
          it just ties the corners back into the page. */}
      <div
        className="absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: imageUrl && imageOk ? 0.35 : 1,
          background:
            `radial-gradient(ellipse 70vw 60vh at 12% -8%, ${gradient[0]}, transparent 62%),` +
            `radial-gradient(ellipse 70vw 60vh at 105% 105%, ${gradient[1]}, transparent 62%)`,
        }}
      />

      {/* Legibility floor. Content sits on this, not on raw artwork — without
          it, a bright photo makes body text unreadable at the top of the page. */}
      <div className="absolute inset-0 bg-gradient-to-b from-background/40 via-background/70 to-background" />
    </div>
  );
}
