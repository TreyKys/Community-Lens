import Link from 'next/link';
import { Eye, ChevronLeft, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

// Shown on /bbn when there is no live or upcoming season — zero markets
// tagged sport='bbn'. A hub that renders "LIVE" chrome over an empty list
// reads as broken. This reads as "the show isn't on right now," which is
// simply true, and points the visitor somewhere real instead of a dead end.
export function BBNComingSoon() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10">
      {/* Same stage-light duotone as the live hero, at rest — dimmer, no
          pulse, because nothing is actually happening right now. */}
      <div className="absolute inset-0 bg-[#0a0a0d]">
        <div className="absolute inset-0 opacity-60"
             style={{ background: 'radial-gradient(ellipse 60vw 40vh at 10% 0%, rgba(217,70,239,0.16), transparent 60%), radial-gradient(ellipse 60vw 40vh at 100% 100%, rgba(245,158,11,0.12), transparent 60%)' }} />
      </div>

      <Eye className="absolute -right-6 -bottom-10 w-56 h-56 text-white/[0.04] rotate-[-8deg]" strokeWidth={1} />

      <div className="relative z-10 flex flex-col items-center text-center gap-4 px-6 py-16 md:py-20">
        <Link href="/markets" className="absolute top-4 left-4">
          <Button variant="ghost" size="icon" className="bg-black/30 backdrop-blur hover:bg-black/50 text-white">
            <ChevronLeft className="w-4 h-4" />
          </Button>
        </Link>

        <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.06] ring-1 ring-white/10 text-white/60 text-[11px] uppercase tracking-[0.18em] font-semibold">
          <Eye className="w-3.5 h-3.5" /> Big Brother Naija
        </div>

        <h1 className="text-2xl md:text-3xl font-black tracking-tight text-white">
          Nobody&rsquo;s in the house right now
        </h1>
        <p className="text-sm text-white/60 max-w-sm">
          When the next season kicks off, evictions, Head of House, and every ship in the
          house land here — real predictions, real money.
        </p>

        <div className="flex flex-col sm:flex-row gap-2 mt-2">
          <Link href="/open/create">
            <Button className="bg-fuchsia-600 hover:bg-fuchsia-500 text-white gap-1.5">
              <Sparkles className="w-4 h-4" /> Start a BBN market yourself
            </Button>
          </Link>
          <Link href="/markets">
            <Button variant="outline" className="border-white/15 text-white/80 hover:bg-white/5 hover:text-white">
              Browse other markets
            </Button>
          </Link>
        </div>
        <p className="text-[11px] text-white/40 max-w-xs">
          Open Markets let anyone create a question and earn from it once it takes off —
          get ahead of the season.
        </p>
      </div>
    </div>
  );
}
