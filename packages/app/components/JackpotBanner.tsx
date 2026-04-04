'use client';

import { useEffect, useState } from 'react';
import { Trophy, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface JackpotState {
  totalPool: number;
  carryover: number;
  qualifiedSlips: number;
}

export function JackpotBanner() {
  const [jackpot, setJackpot] = useState<JackpotState | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => {
    fetch('/api/jackpot')
      .then(r => r.json())
      .then(data => {
        if (!data.error) {
          setJackpot(data);
          setIsAnimating(true);
          setTimeout(() => setIsAnimating(false), 600);
        }
      })
      .catch(() => {});

    // Refresh every 2 minutes
    const interval = setInterval(() => {
      fetch('/api/jackpot')
        .then(r => r.json())
        .then(data => {
          if (!data.error) {
            setJackpot(prev => {
              if (prev && data.totalPool !== prev.totalPool) {
                setIsAnimating(true);
                setTimeout(() => setIsAnimating(false), 600);
              }
              return data;
            });
          }
        })
        .catch(() => {});
    }, 120000);

    return () => clearInterval(interval);
  }, []);

  if (!jackpot || jackpot.totalPool === 0) return null;

  const hasCarryover = jackpot.carryover > 0;

  return (
    <div className={cn(
      'mx-4 mb-4 rounded-xl border overflow-hidden transition-all duration-500',
      hasCarryover
        ? 'bg-gradient-to-r from-amber-500/10 via-orange-500/10 to-amber-500/10 border-amber-500/30'
        : 'bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-blue-500/10 border-blue-500/20'
    )}>
      <div className="px-4 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={cn(
            'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
            hasCarryover ? 'bg-amber-500/20' : 'bg-blue-500/20'
          )}>
            <Trophy className={cn('w-4 h-4', hasCarryover ? 'text-amber-400' : 'text-blue-400')} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className={cn(
                'text-xs font-bold uppercase tracking-widest',
                hasCarryover ? 'text-amber-400' : 'text-blue-400'
              )}>
                {hasCarryover ? '🔥 Carryover Jackpot' : 'Weekly Jackpot'}
              </span>
              {jackpot.qualifiedSlips > 0 && (
                <span className="text-xs text-muted-foreground">
                  · {jackpot.qualifiedSlips} slip{jackpot.qualifiedSlips !== 1 ? 's' : ''} entered
                </span>
              )}
            </div>
            <div className={cn(
              'text-xl font-black tracking-tight transition-all duration-300',
              isAnimating ? 'scale-105' : 'scale-100',
              hasCarryover ? 'text-amber-300' : 'text-foreground'
            )}>
              ₦{jackpot.totalPool.toLocaleString()}
            </div>
            {hasCarryover && (
              <p className="text-xs text-amber-400/70">
                Includes ₦{jackpot.carryover.toLocaleString()} nobody won last week
              </p>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Zap className="w-3 h-3" />
            <span>Bet 6+ markets</span>
          </div>
          <div className="text-xs text-muted-foreground">≥ ₦500 to qualify</div>
        </div>
      </div>
    </div>
  );
}
