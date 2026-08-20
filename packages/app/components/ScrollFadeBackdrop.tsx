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
      className="fixed inset-0 -z-10 pointer-events-none will-change-[opacity]"
    >
      {imageUrl && imageOk && (
        <Image
          src={imageUrl}
          alt={alt || ''}
          fill
          priority
          unoptimized
          sizes="100vw"
          className="object-cover"
          onError={() => setImageOk(false)}
        />
      )}

      {/* Gradient art. Sits ABOVE the photo when there is one (tinting it into
          the site's palette) and IS the backdrop when there isn't. Static —
          no blur filter, no animation. */}
      <div
        className="absolute inset-0"
        style={{
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
