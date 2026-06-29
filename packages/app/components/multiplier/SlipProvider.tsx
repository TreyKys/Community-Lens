'use client';

import { createContext, useContext, useState, useEffect, useCallback } from 'react';

// One leg the user has added to their in-progress Multiplier slip. We
// keep enough to render the slip without re-fetching; live odds come
// from /api/multiplier/quote.
export interface SlipLeg {
  marketId: number;
  outcomeIndex: number;
  marketQuestion: string;
  optionLabel: string;
}

interface SlipContextValue {
  legs: SlipLeg[];
  /** Add a leg. One leg per market — adding another pick on the same
   *  market replaces the existing one (mirrors the one-leg-per-event
   *  rule the engine enforces). */
  addLeg: (leg: SlipLeg) => void;
  removeLeg: (marketId: number) => void;
  clear: () => void;
  /** Replace the whole slip in one shot. Used by the OPx Picks "Stake
   *  as is" / "Make It Yours" flow to drop the inviter's legs into a
   *  fresh slip without mutating each in turn. */
  replaceLegs: (legs: SlipLeg[]) => void;
  /** Is this exact (market, outcome) already in the slip? */
  hasLeg: (marketId: number, outcomeIndex: number) => boolean;
  /** Is this market in the slip on ANY outcome? */
  hasMarket: (marketId: number) => boolean;
  isOpen: boolean;
  setOpen: (v: boolean) => void;
  /** Pre-fill stake the slip builder should consume on next mount. Set
   *  by the OPx Picks clone flow; cleared after MultiplierSlip reads
   *  it. ₦0 / null = nothing to prefill. */
  prefillStakeNgn: number | null;
  setPrefillStakeNgn: (v: number | null) => void;
}

const SlipContext = createContext<SlipContextValue | null>(null);
const STORAGE_KEY = 'opinionsng_multiplier_slip_v1';

export function SlipProvider({ children }: { children: React.ReactNode }) {
  const [legs, setLegs] = useState<SlipLeg[]>([]);
  const [isOpen, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [prefillStakeNgn, setPrefillStakeNgn] = useState<number | null>(null);

  // Hydrate once from localStorage so the slip survives navigation /
  // reloads while the user shops for legs across markets.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) setLegs(parsed);
      }
    } catch { /* ignore corrupt storage */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(legs)); } catch { /* quota */ }
  }, [legs, hydrated]);

  const addLeg = useCallback((leg: SlipLeg) => {
    setLegs(prev => {
      const withoutMarket = prev.filter(l => l.marketId !== leg.marketId);
      return [...withoutMarket, leg];
    });
  }, []);

  const removeLeg = useCallback((marketId: number) => {
    setLegs(prev => prev.filter(l => l.marketId !== marketId));
  }, []);

  const clear = useCallback(() => setLegs([]), []);

  const replaceLegs = useCallback((next: SlipLeg[]) => {
    setLegs(next);
  }, []);

  const hasLeg = useCallback(
    (marketId: number, outcomeIndex: number) =>
      legs.some(l => l.marketId === marketId && l.outcomeIndex === outcomeIndex),
    [legs],
  );

  const hasMarket = useCallback(
    (marketId: number) => legs.some(l => l.marketId === marketId),
    [legs],
  );

  return (
    <SlipContext.Provider value={{ legs, addLeg, removeLeg, clear, replaceLegs, hasLeg, hasMarket, isOpen, setOpen, prefillStakeNgn, setPrefillStakeNgn }}>
      {children}
    </SlipContext.Provider>
  );
}

export function useSlip(): SlipContextValue {
  const ctx = useContext(SlipContext);
  if (!ctx) throw new Error('useSlip must be used within a SlipProvider');
  return ctx;
}
