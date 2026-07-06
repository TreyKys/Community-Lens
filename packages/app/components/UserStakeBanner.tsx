'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Wallet, Target, CheckCircle2 } from 'lucide-react';

interface UserStake {
  id: string;
  stake_tngn: number;
  outcome_index: number;
  status: string;
  market_id: number;
}

interface MarketLite {
  options?: string[];
}

export function UserStakeBanner({ marketId }: { marketId: number }) {
  const [stakes, setStakes] = useState<UserStake[]>([]);
  const [market, setMarket] = useState<MarketLite | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user?.id) {
        if (!cancelled) setLoaded(true);
        return;
      }

      const [{ data: betRows }, { data: marketRow }] = await Promise.all([
        supabase
          .from('user_bets')
          .select('id, stake_tngn, outcome_index, status, market_id')
          .eq('user_id', session.user.id)
          .eq('market_id', marketId)
          .in('status', ['active', 'won', 'lost', 'refunded'])
          .order('placed_at', { ascending: false }),
        supabase.from('markets').select('options').eq('id', marketId).single(),
      ]);

      if (cancelled) return;
      setStakes((betRows as UserStake[]) || []);
      setMarket(marketRow as MarketLite | null);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [marketId]);

  if (!loaded || stakes.length === 0) return null;

  const totalStaked = stakes.reduce((s, b) => s + (b.stake_tngn || 0), 0);
  const activeCount = stakes.filter(s => s.status === 'active').length;
  const options = market?.options || [];

  return (
    <div className="bg-emerald-500/8 border border-emerald-500/25 rounded-xl px-4 py-3 mb-4">
      <div className="flex items-center gap-2 mb-2">
        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
        <p className="text-xs font-semibold text-emerald-300 uppercase tracking-wider">
          Your position on this market
        </p>
      </div>
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-1.5 text-foreground">
          <Wallet className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="font-bold tabular-nums">₦{totalStaked.toLocaleString()}</span>
          <span className="text-muted-foreground text-xs">
            across {stakes.length} prediction{stakes.length !== 1 ? 's' : ''}
            {activeCount > 0 && activeCount !== stakes.length && ` (${activeCount} live)`}
          </span>
        </div>
      </div>
      {stakes.length <= 3 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {stakes.map(s => (
            <span
              key={s.id}
              className="text-[10px] bg-background/60 border border-emerald-500/20 rounded-md px-2 py-0.5 flex items-center gap-1"
            >
              <Target className="w-2.5 h-2.5 text-emerald-400" />
              <span className="font-medium">{options[s.outcome_index] || `Option ${s.outcome_index}`}</span>
              <span className="text-muted-foreground">· ₦{s.stake_tngn.toLocaleString()}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
