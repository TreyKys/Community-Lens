'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Lock, CheckCircle2, ChevronLeft, Search } from 'lucide-react';
import Link from 'next/link';
import { Input } from '@/components/ui/input';

const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_SECRET || '';

export default function ResolvePage() {
  const [markets, setMarkets] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [winningOutcomes, setWinningOutcomes] = useState<Record<number, string>>({});
  const [searchTerm, setSearchTerm] = useState('');
  const { toast } = useToast();

  const fetchMarkets = async () => {
    setIsLoading(true);
    const { data } = await supabase
      .from('markets')
      .select('*')
      .in('status', ['open', 'locked'])
      .order('closes_at', { ascending: true });

    if (data) setMarkets(data);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchMarkets();
  }, []);

  const handleResolve = async (market: any) => {
    const outcomeIndex = winningOutcomes[market.id];
    if (!outcomeIndex) return;

    setResolvingId(market.id);
    try {
      if (market.status === 'open') {
        const lockRes = await fetch('/api/markets/lock', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ADMIN_SECRET}`,
          },
          body: JSON.stringify({ marketId: market.id }),
        });
        if (!lockRes.ok) throw new Error('Failed to lock market before resolution');
      }

      const resolveRes = await fetch('/api/markets/resolve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ADMIN_SECRET}`,
        },
        body: JSON.stringify({ marketId: market.id, winningOutcomeIndex: parseInt(outcomeIndex) }),
      });
      const d = await resolveRes.json();
      if (!resolveRes.ok) throw new Error(d.error || 'Failed to resolve');

      toast({ title: 'Success', description: 'Market resolved successfully.' });
      fetchMarkets();
    } catch (err: any) {
      toast({ title: 'Error', description: err.message, variant: 'destructive' });
    } finally {
      setResolvingId(null);
    }
  };

  const filteredMarkets = markets.filter(m =>
    m.question.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.category.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const pending = markets.length;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-4 border-b pb-4">
        <Link href="/admin">
          <Button variant="ghost" size="icon">
            <ChevronLeft className="w-5 h-5" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold">Resolve Markets</h1>
          <p className="text-xs text-muted-foreground">
            All markets requiring manual resolution
            {pending > 0 && ` — ${pending} awaiting`}
          </p>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Search markets..."
          className="pl-9"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : filteredMarkets.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground border rounded-xl bg-card/50">
          No pending markets found.
        </div>
      ) : (
        <div className="grid gap-4">
          {filteredMarkets.map(market => (
            <Card key={market.id} className="overflow-hidden">
              <CardHeader className="bg-muted/20 pb-3">
                <div className="flex justify-between items-start gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {market.category}
                      </Badge>
                      <Badge variant={market.status === 'locked' ? 'secondary' : 'default'} className="text-[10px] uppercase">
                        {market.status}
                      </Badge>
                    </div>
                    <CardTitle className="text-base">{market.question}</CardTitle>
                  </div>
                  <div className="text-right text-xs text-muted-foreground shrink-0">
                    ID: {market.id}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-4">
                <div className="flex flex-col md:flex-row gap-4 items-end">
                  <div className="w-full">
                    <Select
                      value={winningOutcomes[market.id] || ''}
                      onValueChange={(val) => setWinningOutcomes(prev => ({ ...prev, [market.id]: val }))}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select winning outcome..." />
                      </SelectTrigger>
                      <SelectContent>
                        {market.options.map((opt: string, i: number) => (
                          <SelectItem key={i} value={i.toString()}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    className="w-full md:w-auto shrink-0"
                    onClick={() => handleResolve(market)}
                    disabled={!winningOutcomes[market.id] || resolvingId === market.id}
                  >
                    {resolvingId === market.id ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 mr-2" />
                    )}
                    {market.status === 'open' ? 'Lock & Resolve' : 'Resolve'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
