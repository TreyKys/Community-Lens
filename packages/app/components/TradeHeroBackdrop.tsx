// Minimalist decorative backdrop for the Trade Markets hero.
//
// A static SVG, not an animated one. globals.css already documents why:
// low-alpha blurred/animated backgrounds cause visible banding on the
// Mali/Adreno GPUs most of this app's traffic runs on (see .opinions-bg).
// Two flat price lines and a faint grid cost nothing to render and never
// jitter, which is the more "immersive" choice on the hardware this
// actually ships to — motion that stutters reads as broken, not alive.
export function TradeHeroBackdrop() {
  return (
    <svg
      viewBox="0 0 400 120"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{
        maskImage: 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to bottom, black 0%, black 55%, transparent 100%)',
      }}
    >
      {/* Faint graph-paper grid — just enough to read as "a chart", not enough to compete with the text on top. */}
      {[24, 48, 72, 96].map(y => (
        <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="currentColor" className="text-emerald-500/[0.07]" strokeWidth="1" />
      ))}
      {[50, 100, 150, 200, 250, 300, 350].map(x => (
        <line key={x} x1={x} y1="0" x2={x} y2="120" stroke="currentColor" className="text-emerald-500/[0.05]" strokeWidth="1" />
      ))}

      {/* Secondary line — muted, choppier, sits behind the primary. */}
      <path
        d="M0,68 L40,74 L80,60 L120,78 L160,64 L200,80 L240,66 L280,82 L320,68 L360,84 L400,72"
        fill="none" stroke="currentColor" className="text-muted-foreground/25" strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round"
      />
      {/* Primary line — the "market moving" read: a real line trending up with noise, not a smooth diagonal. */}
      <path
        d="M0,92 L36,80 L72,88 L108,62 L144,70 L180,48 L216,55 L252,32 L288,40 L324,20 L360,28 L400,14"
        fill="none" stroke="currentColor" className="text-emerald-500/40" strokeWidth="2"
        strokeLinejoin="round" strokeLinecap="round"
      />
    </svg>
  );
}
