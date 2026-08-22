'use client';

import { useEffect, useState } from 'react';
import { Check, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

// The confirmation moment.
//
// A placed bet used to be a toast — the same grey slab that says "copied to
// clipboard". That is the single biggest emotional beat in the product and it
// was indistinguishable from an incidental notice.
//
// This is the one deliberate flourish in the app, and it is doing a job beyond
// decoration: it states, at the moment of commitment and in one glance, WHAT
// YOU WIN IF YOU ARE RIGHT. That number is the reason someone staked, and
// until now they had to go and find it.
//
// Deliberately brief. It celebrates and gets out of the way — an overlay that
// has to be dismissed turns a good feeling into a chore by the fifth bet, so
// it auto-closes and any tap kills it early.

const VISIBLE_MS = 2600;

export function StakeConfirmation({ pick, stakeTngn, returnsTngn, onDone }: {
  pick: string;
  stakeTngn: number;
  /** What lands in the wallet if this comes in. Undefined when the engine
      genuinely cannot say yet — better silent than confidently wrong. */
  returnsTngn?: number | null;
  onDone: () => void;
}) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    // Next frame, so the element mounts at rest and then transitions — set on
    // the same frame the browser skips straight to the end state.
    const raf = requestAnimationFrame(() => setShown(true));
    const t = setTimeout(onDone, VISIBLE_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(t); };
  }, [onDone]);

  const profit = returnsTngn != null ? Math.max(0, returnsTngn - stakeTngn) : null;

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={onDone}
      className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-background/70 backdrop-blur-sm"
    >
      <div
        className={cn(
          'w-full max-w-[280px] rounded-2xl border border-emerald-500/30 bg-popover p-6',
          'text-center space-y-3',
          'shadow-[0_0_60px_-12px_rgba(27,202,121,0.45)]',
          'transition-all duration-300 ease-out',
          shown ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
      >
        <div className="mx-auto w-12 h-12 rounded-full bg-emerald-500/15 flex items-center justify-center">
          <Check className={cn(
            'w-6 h-6 text-emerald-400 transition-transform duration-500 ease-out',
            shown ? 'scale-100' : 'scale-0',
          )} />
        </div>

        <div>
          <p className="text-xs text-muted-foreground">You&rsquo;re in on</p>
          <p className="text-base font-semibold leading-tight mt-0.5">{pick}</p>
        </div>

        <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 p-3">
          {returnsTngn != null ? (
            <>
              <p className="text-[10px] uppercase tracking-wider text-emerald-300/80">If you&rsquo;re right</p>
              <p className="text-2xl font-bold tabular text-emerald-300 leading-none mt-1">
                ₦{Math.round(returnsTngn).toLocaleString()}
              </p>
              {profit != null && profit > 0 && (
                <p className="text-[10px] text-emerald-400/70 mt-1 flex items-center justify-center gap-0.5">
                  <TrendingUp className="w-3 h-3" />
                  ₦{Math.round(profit).toLocaleString()} profit
                </p>
              )}
            </>
          ) : (
            <>
              <p className="text-[10px] uppercase tracking-wider text-emerald-300/80">Staked</p>
              <p className="text-2xl font-bold tabular text-emerald-300 leading-none mt-1">
                ₦{Math.round(stakeTngn).toLocaleString()}
              </p>
            </>
          )}
        </div>

        <p className="text-[10px] text-muted-foreground">Tap anywhere to close</p>
      </div>
    </div>
  );
}
