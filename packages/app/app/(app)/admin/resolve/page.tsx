'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Loader2, CheckCircle2, ChevronLeft, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { DataTable, Column } from '@/components/admin/DataTable';

const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_SECRET || '';

function adminHeaders() {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN_SECRET}` };
}

type MarketRow = {
  id: number;
  question: string;
  category: string;
  status: 'open' | 'locked';
  closes_at: string;
  options: string[];
  total_pool?: number;
  distribution: { option: string; count: number; stake: number; percentage: number }[];
};

export default function ResolvePage() {
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [confirmMarket, setConfirmMarket] = useState<MarketRow | null>(null);
  const [confirmOutcome, setConfirmOutcome] = useState<string>('');
  const [isResolving, setIsResolving] = useState(false);
  const { toast } = useToast();

  const fetchMarkets = useCallback(async () => {
    setIsLoading(true);

    const { data: raw } = await supabase
      .from('markets')
      .select('id, question, category, status, closes_at, options, total_pool')
      .in('status', ['open', 'locked'])
      .order('closes_at', { ascending: true });

    if (!raw) {
      setMarkets([]);
      setIsLoading(false);
      return;
    }

    const enriched: MarketRow[] = [];
    for (const m of raw as any[]) {
      const { data: bets } = await supabase
        .from('user_bets')
        .select('outcome_index, net_stake_tngn')
        .eq('market_id', m.id)
        .eq('status', 'active');

      const total = bets?.reduce((s, b) => s + (b.net_stake_tngn || 0), 0) ?? 0;
      const distribution = (m.options as string[]).map((opt, i) => {
        const forOption = (bets || []).filter((b) => b.outcome_index === i);
        const stake = forOption.reduce((s, b) => s + (b.net_stake_tngn || 0), 0);
        return {
          option: opt,
          count: forOption.length,
          stake,
          percentage: total > 0 ? Math.round((stake / total) * 100) : 0,
        };
      });

      enriched.push({ ...m, distribution });
    }

    setMarkets(enriched);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    fetchMarkets();
  }, [fetchMarkets]);

  const performResolve = async (market: MarketRow, outcomeIndex: number) => {
    if (market.status === 'open') {
      const lockRes = await fetch('/api/markets/lock', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ marketId: market.id }),
      });
      if (!lockRes.ok) throw new Error('Failed to lock market before resolution');
    }

    const resolveRes = await fetch('/api/markets/resolve', {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ marketId: market.id, winningOutcomeIndex: outcomeIndex }),
    });
    const data = await resolveRes.json();
    if (!resolveRes.ok) throw new Error(data.error || 'Resolution failed');
    return data;
  };

  const handleConfirmResolve = async () => {
    if (!confirmMarket || confirmOutcome === '') return;
    setIsResolving(true);
    try {
      const result = await performResolve(confirmMarket, parseInt(confirmOutcome));
      toast({
        title: 'Market resolved',
        description: `${result.winnersCount ?? 0} winner(s) paid out. Pool ₦${(result.totalPool || 0).toLocaleString()}.`,
      });
      setConfirmMarket(null);
      setConfirmOutcome('');
      fetchMarkets();
    } catch (err: any) {
      toast({ title: 'Resolve failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsResolving(false);
    }
  };

  const columns: Column<MarketRow>[] = [
    {
      key: 'id',
      label: 'ID',
      sortable: true,
      sortValue: (r) => r.id,
      className: 'w-16 font-mono text-xs',
    },
    {
      key: 'question',
      label: 'Question',
      sortable: true,
      sortValue: (r) => r.question,
      render: (r) => (
        <div className="max-w-md">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="outline" className="text-[10px] uppercase">{r.category}</Badge>
            <Badge
              variant={r.status === 'locked' ? 'secondary' : 'default'}
              className="text-[10px] uppercase"
            >
              {r.status}
            </Badge>
          </div>
          <div className="text-sm font-medium leading-tight line-clamp-2">{r.question}</div>
        </div>
      ),
    },
    {
      key: 'distribution',
      label: 'Bet Distribution',
      render: (r) => (
        <div className="w-56 space-y-1">
          {r.distribution.map((d, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground w-20 truncate">{d.option}</span>
              <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${d.percentage}%`,
                    background: i === 0 ? '#3b82f6' : i === 1 ? '#f59e0b' : '#ef4444',
                  }}
                />
              </div>
              <span className="text-[10px] font-medium w-8 text-right">{d.percentage}%</span>
            </div>
          ))}
          {r.distribution.every((d) => d.count === 0) && (
            <span className="text-[11px] text-muted-foreground italic">No bets yet</span>
          )}
        </div>
      ),
    },
    {
      key: 'total_pool',
      label: 'Pool',
      sortable: true,
      sortValue: (r) => r.total_pool || 0,
      render: (r) => `₦${(r.total_pool || 0).toLocaleString()}`,
      className: 'text-xs',
    },
    {
      key: 'closes_at',
      label: 'Closes',
      sortable: true,
      sortValue: (r) => new Date(r.closes_at).getTime(),
      render: (r) => (
        <span className="text-xs text-muted-foreground">
          {new Date(r.closes_at).toLocaleString('en-NG', {
            day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
          })}
        </span>
      ),
    },
    {
      key: 'resolve',
      label: '',
      render: (r) => (
        <Button
          size="sm"
          className="h-7 text-xs gap-1"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmMarket(r);
            setConfirmOutcome('');
          }}
        >
          <CheckCircle2 className="w-3 h-3" />
          Resolve
        </Button>
      ),
      className: 'w-28 text-right',
    },
  ];

  const selectedDist = confirmMarket && confirmOutcome !== ''
    ? confirmMarket.distribution[parseInt(confirmOutcome)]
    : null;
  const loserStake = confirmMarket && confirmOutcome !== ''
    ? confirmMarket.distribution
        .filter((_, i) => i !== parseInt(confirmOutcome))
        .reduce((s, d) => s + d.stake, 0)
    : 0;
  const winnerStake = selectedDist?.stake ?? 0;

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-4 border-b pb-4">
        <Link href="/admin">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Resolve Markets</h1>
          <p className="text-xs text-muted-foreground">
            Live bet distribution shown per market. Preview payouts before you confirm.
          </p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <DataTable
          rows={markets}
          columns={columns}
          rowKey={(r) => r.id}
          searchFields={(r) => `${r.id} ${r.question} ${r.category} ${r.status}`}
          pageSize={15}
          emptyMessage="No pending markets to resolve"
        />
      )}

      <Dialog open={!!confirmMarket} onOpenChange={(open) => !open && setConfirmMarket(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm Resolution</DialogTitle>
            <DialogDescription>Payouts are irreversible. Review before you confirm.</DialogDescription>
          </DialogHeader>

          {confirmMarket && (
            <div className="space-y-4">
              <Card className="bg-muted/20">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">{confirmMarket.question}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div>
                    <label className="text-xs uppercase tracking-wider text-muted-foreground mb-1 block">
                      Winning outcome
                    </label>
                    <Select value={confirmOutcome} onValueChange={setConfirmOutcome}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select the outcome..." />
                      </SelectTrigger>
                      <SelectContent>
                        {confirmMarket.options.map((opt, i) => {
                          const d = confirmMarket.distribution[i];
                          return (
                            <SelectItem key={i} value={i.toString()}>
                              {opt} — {d.percentage}% ({d.count} bet{d.count !== 1 ? 's' : ''})
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>

                  {confirmOutcome !== '' && selectedDist && (
                    <div className="space-y-2 pt-2 border-t border-muted">
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Winning pool</span>
                        <span className="font-medium">₦{winnerStake.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Losing pool</span>
                        <span className="font-medium">₦{loserStake.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-xs">
                        <span className="text-muted-foreground">Winners</span>
                        <span className="font-medium">{selectedDist.count}</span>
                      </div>
                      {winnerStake === 0 && loserStake === 0 && (
                        <div className="flex items-center gap-2 text-xs text-amber-400 mt-2">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          No bets placed — market will be voided.
                        </div>
                      )}
                      {(winnerStake === 0 || loserStake === 0) && (winnerStake + loserStake > 0) && (
                        <div className="flex items-center gap-2 text-xs text-amber-400 mt-2">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          One-sided market — all bets will be refunded.
                        </div>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmMarket(null)} disabled={isResolving}>
              Cancel
            </Button>
            <Button
              className="bg-emerald-600 hover:bg-emerald-500"
              disabled={confirmOutcome === '' || isResolving}
              onClick={handleConfirmResolve}
            >
              {isResolving ? (
                <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resolving...</>
              ) : (
                <><CheckCircle2 className="w-4 h-4 mr-2" />Confirm & Pay Winners</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
