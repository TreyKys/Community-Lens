'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Shield, Zap, Lock, CheckCircle2, AlertTriangle, TrendingUp, Users, Coins, Activity, Sparkles, Upload, Trash2, Send } from 'lucide-react';
import { cn } from '@/lib/utils';

const ADMIN_SECRET = process.env.NEXT_PUBLIC_ADMIN_SECRET || '';

function adminHeaders() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ADMIN_SECRET}`,
  };
}

function cronHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-cron-secret': process.env.NEXT_PUBLIC_CRON_SECRET || '',
  };
}

// ── Treasury Overview ────────────────────────────────────────────────────
function TreasuryPanel() {
  const [stats, setStats] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function fetchStats() {
      const [rakeData, usersData, marketsData, heartbeatData] = await Promise.all([
        supabase.from('treasury_log').select('amount_tngn, type').then(r => r.data || []),
        supabase.from('users').select('id', { count: 'exact', head: true }).then(r => r.count || 0),
        supabase.from('markets').select('status', { count: 'exact', head: false }).then(r => r.data || []),
        supabase.from('heartbeat_log').select('fired_at').order('fired_at', { ascending: false }).limit(1).then(r => r.data?.[0] || null),
      ]);

      const entryRake = rakeData.filter((r: any) => r.type === 'entry_rake').reduce((s: number, r: any) => s + r.amount_tngn, 0);
      const resolutionRake = rakeData.filter((r: any) => r.type === 'resolution_rake').reduce((s: number, r: any) => s + r.amount_tngn, 0);
      const totalRake = entryRake + resolutionRake;

      const openMarkets = (marketsData as any[]).filter(m => m.status === 'open').length;
      const lockedMarkets = (marketsData as any[]).filter(m => m.status === 'locked').length;

      const lastHeartbeat = heartbeatData?.fired_at ? new Date(heartbeatData.fired_at) : null;
      const daysSinceHeartbeat = lastHeartbeat
        ? Math.floor((Date.now() - lastHeartbeat.getTime()) / (1000 * 60 * 60 * 24))
        : null;

      setStats({ totalRake, entryRake, resolutionRake, usersData, openMarkets, lockedMarkets, lastHeartbeat, daysSinceHeartbeat });
      setIsLoading(false);
    }
    fetchStats();
  }, []);

  if (isLoading) return <div className="h-32 bg-muted/30 rounded-xl animate-pulse" />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Rake', value: `₦${(stats?.totalRake || 0).toLocaleString()}`, icon: Coins, color: 'text-emerald-400' },
          { label: 'Total Users', value: stats?.usersData || 0, icon: Users, color: 'text-blue-400' },
          { label: 'Open Markets', value: stats?.openMarkets || 0, icon: Activity, color: 'text-amber-400' },
          { label: 'Locked Markets', value: stats?.lockedMarkets || 0, icon: Lock, color: 'text-purple-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="bg-card/50">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
                <Icon className={cn('w-4 h-4', color)} />
              </div>
              <div className="text-2xl font-bold">{value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Heartbeat status */}
      <Card className={cn('border', stats?.daysSinceHeartbeat >= 25 ? 'border-red-500/40 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5')}>
        <CardContent className="p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Shield className={cn('w-5 h-5', stats?.daysSinceHeartbeat >= 25 ? 'text-red-400' : 'text-emerald-400')} />
            <div>
              <p className="text-sm font-medium">Escape Hatch Clock</p>
              <p className="text-xs text-muted-foreground">
                {stats?.lastHeartbeat
                  ? `Last heartbeat: ${stats.lastHeartbeat.toLocaleDateString()} (${stats.daysSinceHeartbeat} days ago)`
                  : 'No heartbeat recorded'}
              </p>
            </div>
          </div>
          <Badge className={cn(stats?.daysSinceHeartbeat >= 25 ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30')}>
            {30 - (stats?.daysSinceHeartbeat || 0)} days remaining
          </Badge>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Market Creation ───────────────────────────────────────────────────────
function CreateMarketPanel() {
  const { toast } = useToast();
  const [question, setQuestion] = useState('');
  const [category, setCategory] = useState('sports');
  const [optionsText, setOptionsText] = useState('Home Win, Draw, Away Win');
  const [closesAt, setClosesAt] = useState('');
  const [fixtureId, setFixtureId] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const PRESETS = [
    { label: '1X2 (Football)', options: 'Home Win, Draw, Away Win' },
    { label: 'Yes/No', options: 'Yes, No' },
    { label: 'Over/Under 2.5', options: 'Over 2.5, Under 2.5' },
    { label: 'BTTS', options: 'Yes - Both Score, No - Both Score' },
    { label: 'Win/Lose', options: 'Win, Lose' },
  ];

  const handleCreate = async () => {
    if (!question || !closesAt) {
      toast({ title: 'Question and close time are required', variant: 'destructive' });
      return;
    }

    const options = optionsText.split(',').map(o => o.trim()).filter(Boolean);
    if (options.length < 2) {
      toast({ title: 'At least 2 options required', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/market', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({
          question,
          category,
          options,
          closesAt: new Date(closesAt).toISOString(),
          fixtureId: fixtureId ? parseInt(fixtureId) : null,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      toast({ title: `Market created! ID: ${data.market.id}` });
      setQuestion('');
      setClosesAt('');
      setFixtureId('');
    } catch (err: any) {
      toast({ title: 'Failed to create market', description: err.message, variant: 'destructive' });
    } finally { setIsSubmitting(false); }
  };

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Create Market</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Category</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="sports">Sports</SelectItem>
              <SelectItem value="politics">Politics</SelectItem>
              <SelectItem value="economics">Economics</SelectItem>
              <SelectItem value="entertainment">Entertainment</SelectItem>
              <SelectItem value="finance">Finance / Crypto</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Question</Label>
          <Input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            placeholder="e.g. [PL] Arsenal vs Chelsea — Match Winner"
          />
          <p className="text-xs text-muted-foreground">Use [PL], [CL], etc. tags for sports leagues</p>
        </div>

        <div className="space-y-2">
          <Label>Options (comma-separated)</Label>
          <Input value={optionsText} onChange={e => setOptionsText(e.target.value)} />
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(p => (
              <button
                key={p.label}
                type="button"
                onClick={() => setOptionsText(p.options)}
                className="text-xs px-2 py-1 bg-muted/50 rounded-md hover:bg-muted transition-colors"
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label>Closes At</Label>
            <Input type="datetime-local" value={closesAt} onChange={e => setClosesAt(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Fixture ID (sports only)</Label>
            <Input
              type="number"
              placeholder="football-data.org ID"
              value={fixtureId}
              onChange={e => setFixtureId(e.target.value)}
            />
          </div>
        </div>

        <Button onClick={handleCreate} disabled={isSubmitting} className="w-full">
          {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Creating...</> : 'Create Market'}
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Manual Override Panel ─────────────────────────────────────────────────
function ManualOverridePanel() {
  const { toast } = useToast();
  const [lockMarketId, setLockMarketId] = useState('');
  const [resolveMarketId, setResolveMarketId] = useState('');
  const [winningOutcome, setWinningOutcome] = useState('');
  const [isLocking, setIsLocking] = useState(false);
  const [isResolving, setIsResolving] = useState(false);
  const [isFiringHeartbeat, setIsFiringHeartbeat] = useState(false);
  const [markets, setMarkets] = useState<any[]>([]);
  const [selectedMarket, setSelectedMarket] = useState<any>(null);

  useEffect(() => {
    supabase
      .from('markets')
      .select('id, question, options, status, closes_at')
      .in('status', ['open', 'locked'])
      .order('closes_at', { ascending: true })
      .limit(30)
      .then(({ data }) => setMarkets(data || []));
  }, []);

  useEffect(() => {
    if (resolveMarketId) {
      const m = markets.find(m => m.id.toString() === resolveMarketId);
      setSelectedMarket(m || null);
    }
  }, [resolveMarketId, markets]);

  const forceLock = async () => {
    if (!lockMarketId) return;
    setIsLocking(true);
    try {
      const res = await fetch('/api/markets/lock', {
        method: 'POST',
        headers: cronHeaders(),
        body: JSON.stringify({ marketId: parseInt(lockMarketId) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: `Market ${lockMarketId} locked! ${data.betCount} bets committed.` });
      setLockMarketId('');
    } catch (err: any) {
      toast({ title: 'Lock failed', description: err.message, variant: 'destructive' });
    } finally { setIsLocking(false); }
  };

  const forceResolve = async () => {
    if (!resolveMarketId || winningOutcome === '') return;
    setIsResolving(true);
    try {
      const res = await fetch('/api/markets/resolve', {
        method: 'POST',
        headers: cronHeaders(),
        body: JSON.stringify({
          marketId: parseInt(resolveMarketId),
          winningOutcomeIndex: parseInt(winningOutcome),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: `Market ${resolveMarketId} resolved! ${data.winnersCount} winners paid.` });
      setResolveMarketId('');
      setWinningOutcome('');
      setSelectedMarket(null);
    } catch (err: any) {
      toast({ title: 'Resolve failed', description: err.message, variant: 'destructive' });
    } finally { setIsResolving(false); }
  };

  const fireHeartbeat = async () => {
    setIsFiringHeartbeat(true);
    try {
      const res = await fetch('/api/admin/heartbeat', {
        method: 'POST',
        headers: cronHeaders(),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: '❤️ Heartbeat fired! Escape hatch clock reset.' });
    } catch (err: any) {
      toast({ title: 'Heartbeat failed', description: err.message, variant: 'destructive' });
    } finally { setIsFiringHeartbeat(false); }
  };

  return (
    <div className="space-y-4">
      {/* Force Lock */}
      <Card className="border-amber-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Lock className="w-4 h-4 text-amber-400" />
            Force Lock Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Use when Inngest missed the kickoff. Computes Merkle root and seals the bet book.</p>
          <div className="flex gap-2">
            <Select value={lockMarketId} onValueChange={setLockMarketId}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select market..." />
              </SelectTrigger>
              <SelectContent>
                {markets.filter(m => m.status === 'open').map(m => (
                  <SelectItem key={m.id} value={m.id.toString()}>
                    {m.id}: {m.question.slice(0, 50)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button onClick={forceLock} disabled={!lockMarketId || isLocking} variant="outline" className="border-amber-500/30">
              {isLocking ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Force Resolve */}
      <Card className="border-emerald-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            Force Resolve Market
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">Use when the oracle failed or for non-sports markets (Pulse).</p>
          <Select value={resolveMarketId} onValueChange={setResolveMarketId}>
            <SelectTrigger>
              <SelectValue placeholder="Select locked market..." />
            </SelectTrigger>
            <SelectContent>
              {markets.filter(m => m.status === 'locked').map(m => (
                <SelectItem key={m.id} value={m.id.toString()}>
                  {m.id}: {m.question.slice(0, 50)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {selectedMarket && (
            <Select value={winningOutcome} onValueChange={setWinningOutcome}>
              <SelectTrigger>
                <SelectValue placeholder="Select winning outcome..." />
              </SelectTrigger>
              <SelectContent>
                {(selectedMarket.options as string[]).map((opt: string, i: number) => (
                  <SelectItem key={i} value={i.toString()}>
                    {i}: {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Button
            onClick={forceResolve}
            disabled={!resolveMarketId || winningOutcome === '' || isResolving}
            className="w-full bg-emerald-600 hover:bg-emerald-500"
          >
            {isResolving ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Resolving...</> : 'Resolve & Pay Winners'}
          </Button>
        </CardContent>
      </Card>

      {/* Heartbeat */}
      <Card className="border-blue-500/20">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            Emergency Heartbeat
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-xs text-muted-foreground">
            Resets the 30-day escape hatch clock. Fire immediately if the weekly Inngest job missed a run.
          </p>
          <Button
            onClick={fireHeartbeat}
            disabled={isFiringHeartbeat}
            variant="outline"
            className="w-full border-blue-500/30"
          >
            {isFiringHeartbeat ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Firing...</> : '❤️ Fire Heartbeat Now'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Withdrawal Approvals ──────────────────────────────────────────────────
function WithdrawalPanel() {
  const { toast } = useToast();
  const [withdrawals, setWithdrawals] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [processingId, setProcessingId] = useState<string | null>(null);

  const fetchWithdrawals = useCallback(async () => {
    const res = await fetch('/api/admin/withdrawals', { headers: adminHeaders() });
    const data = await res.json();
    setWithdrawals(data.withdrawals || []);
    setIsLoading(false);
  }, []);

  useEffect(() => { fetchWithdrawals(); }, [fetchWithdrawals]);

  const handleAction = async (withdrawalId: string, action: 'approve' | 'reject', reason?: string) => {
    setProcessingId(withdrawalId);
    try {
      const res = await fetch('/api/admin/withdrawals', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ withdrawalId, action, reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast({ title: action === 'approve' ? 'Withdrawal approved ✅' : 'Withdrawal rejected' });
      fetchWithdrawals();
    } catch (err: any) {
      toast({ title: 'Action failed', description: err.message, variant: 'destructive' });
    } finally { setProcessingId(null); }
  };

  if (isLoading) return <div className="h-24 bg-muted/30 rounded-xl animate-pulse" />;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          Pending Large Withdrawals
          <Badge variant="outline">{withdrawals.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {withdrawals.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No pending approvals</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Naira to send</TableHead>
                <TableHead>Bank</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {withdrawals.map((w: any) => (
                <TableRow key={w.id}>
                  <TableCell className="text-xs font-mono">{w.users?.email || w.user_id.slice(0, 8)}</TableCell>
                  <TableCell className="font-medium">₦{w.amount_tngn.toLocaleString()}</TableCell>
                  <TableCell>₦{w.naira_to_send.toLocaleString()}</TableCell>
                  <TableCell className="text-xs">{w.bank_code}/{w.account_number}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-emerald-600 hover:bg-emerald-500"
                        disabled={processingId === w.id}
                        onClick={() => handleAction(w.id, 'approve')}
                      >
                        {processingId === w.id ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Approve'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs border-red-500/30 text-red-400"
                        disabled={processingId === w.id}
                        onClick={() => handleAction(w.id, 'reject', 'Rejected by admin')}
                      >
                        Reject
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── AI Market Generator ───────────────────────────────────────────────────
function AIMarketGenerator() {
  const { toast } = useToast();
  const [docText, setDocText] = useState('');
  const [docName, setDocName] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [drafts, setDrafts] = useState<any[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocName(file.name);
    const reader = new FileReader();
    reader.onload = (ev) => setDocText(ev.target?.result as string || '');
    reader.readAsText(file);
  };

  const handleGenerate = async () => {
    if (!docText.trim()) {
      toast({ title: 'Paste or upload a document first', variant: 'destructive' });
      return;
    }
    setIsGenerating(true);
    try {
      const res = await fetch('/api/admin/generate-markets', {
        method: 'POST',
        headers: adminHeaders(),
        body: JSON.stringify({ documentContent: docText, documentName: docName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDrafts(data.markets);
      toast({ title: `${data.markets.length} markets generated. Review and submit.` });
    } catch (err: any) {
      toast({ title: 'Generation failed', description: err.message, variant: 'destructive' });
    } finally { setIsGenerating(false); }
  };

  const updateDraft = (id: string, field: string, value: any) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, [field]: value } : d));
  };

  const removeDraft = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
  };

  const toggleApprove = (id: string) => {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, approved: !d.approved } : d));
  };

  const approveAll = () => setDrafts(prev => prev.map(d => ({ ...d, approved: true })));

  const handleSubmitApproved = async () => {
    const approved = drafts.filter(d => d.approved);
    if (approved.length === 0) {
      toast({ title: 'Approve at least one market first', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    let created = 0;
    let failed = 0;
    for (const draft of approved) {
      try {
        const res = await fetch('/api/admin/market', {
          method: 'POST',
          headers: adminHeaders(),
          body: JSON.stringify({
            question: draft.question,
            category: draft.category,
            sport: draft.sport,
            options: draft.options,
            closesAt: draft.closes_at,
            fixtureId: draft.fixture_id,
            homeTeam: draft.home_team,
            awayTeam: draft.away_team,
          }),
        });
        if (res.ok) { created++; } else { failed++; }
      } catch { failed++; }
    }
    setDrafts(prev => prev.filter(d => !d.approved));
    toast({
      title: `${created} market${created !== 1 ? 's' : ''} created${failed > 0 ? `, ${failed} failed` : ''}`,
    });
    setIsSubmitting(false);
  };

  const approvedCount = drafts.filter(d => d.approved).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-purple-400" />
            AI Market Generator
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Paste a document (fixture list, news article, event schedule) or upload a text file.
            AI will generate prediction markets. You review and approve before anything goes live.
          </p>

          <div className="flex gap-2">
            <label className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg cursor-pointer hover:bg-muted/30 transition-colors text-sm">
              <Upload className="w-4 h-4" />
              Upload .txt or .csv
              <input type="file" accept=".txt,.csv,.md" className="sr-only" onChange={handleFileUpload} />
            </label>
            {docName && <span className="text-xs text-muted-foreground self-center truncate max-w-48">{docName}</span>}
          </div>

          <div className="space-y-2">
            <Label>Or paste document content directly</Label>
            <textarea
              className="w-full h-40 bg-muted/30 border border-border rounded-lg p-3 text-sm font-mono resize-none focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder="Paste fixture lists, news, schedules, event briefs here..."
              value={docText}
              onChange={e => setDocText(e.target.value)}
            />
            <p className="text-xs text-muted-foreground text-right">{docText.length.toLocaleString()} / 50,000 chars</p>
          </div>

          <Button onClick={handleGenerate} disabled={isGenerating || !docText.trim()} className="w-full gap-2">
            {isGenerating
              ? <><Loader2 className="w-4 h-4 animate-spin" />Generating markets...</>
              : <><Sparkles className="w-4 h-4" />Generate Markets with AI</>
            }
          </Button>
        </CardContent>
      </Card>

      {drafts.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Review Drafts ({drafts.length} generated, {approvedCount} approved)
              </CardTitle>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={approveAll}>
                  Approve All
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-500"
                  disabled={approvedCount === 0 || isSubmitting}
                  onClick={handleSubmitApproved}
                >
                  {isSubmitting
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <Send className="w-3 h-3" />
                  }
                  Submit {approvedCount} Approved
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-[600px] overflow-y-auto pr-1">
              {drafts.map(draft => (
                <div
                  key={draft.id}
                  className={cn(
                    'border rounded-xl p-4 space-y-3 transition-all',
                    draft.approved ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-border'
                  )}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3 flex-1 min-w-0">
                      <input
                        type="checkbox"
                        checked={draft.approved}
                        onChange={() => toggleApprove(draft.id)}
                        className="mt-1 w-4 h-4 cursor-pointer accent-emerald-500"
                      />
                      <div className="flex-1 min-w-0">
                        <input
                          type="text"
                          value={draft.question}
                          onChange={e => updateDraft(draft.id, 'question', e.target.value)}
                          className="w-full bg-transparent text-sm font-medium border-b border-transparent hover:border-border focus:border-primary focus:outline-none pb-0.5"
                        />
                        {draft.notes && (
                          <p className="text-xs text-muted-foreground mt-1 italic">{draft.notes}</p>
                        )}
                      </div>
                    </div>
                    <button onClick={() => removeDraft(draft.id)} className="text-muted-foreground hover:text-red-400 transition-colors shrink-0">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pl-7">
                    <div>
                      <Label className="text-xs">Category</Label>
                      <Select value={draft.category} onValueChange={v => updateDraft(draft.id, 'category', v)}>
                        <SelectTrigger className="h-7 text-xs mt-1"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sports">Sports</SelectItem>
                          <SelectItem value="politics">Politics</SelectItem>
                          <SelectItem value="economics">Economics</SelectItem>
                          <SelectItem value="entertainment">Entertainment</SelectItem>
                          <SelectItem value="finance">Finance</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs">Closes At</Label>
                      <Input
                        type="datetime-local"
                        value={draft.closes_at ? draft.closes_at.slice(0, 16) : ''}
                        onChange={e => updateDraft(draft.id, 'closes_at', new Date(e.target.value).toISOString())}
                        className="h-7 text-xs mt-1"
                      />
                    </div>
                    <div className="col-span-2">
                      <Label className="text-xs">Options (comma-separated)</Label>
                      <Input
                        value={(draft.options as string[]).join(', ')}
                        onChange={e => updateDraft(draft.id, 'options', e.target.value.split(',').map((o: string) => o.trim()).filter(Boolean))}
                        className="h-7 text-xs mt-1"
                      />
                    </div>
                  </div>

                  <div className="pl-7 flex flex-wrap gap-1">
                    {(draft.options as string[]).map((opt: string, i: number) => (
                      <Badge key={i} variant="outline" className="text-xs">{opt}</Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main Admin Page ───────────────────────────────────────────────────────
export default function AdminPage() {
  const [session, setSession] = useState<any>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminInput, setAdminInput] = useState('');
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setIsChecking(false);
    });
  }, []);

  const handleAdminLogin = () => {
    if (adminInput === ADMIN_SECRET || adminInput === process.env.NEXT_PUBLIC_ADMIN_SECRET) {
      setIsAdmin(true);
      localStorage.setItem('tm_admin', adminInput);
    }
  };

  useEffect(() => {
    const stored = localStorage.getItem('tm_admin');
    if (stored && (stored === ADMIN_SECRET || stored === process.env.NEXT_PUBLIC_ADMIN_SECRET)) {
      setIsAdmin(true);
    }
  }, []);

  if (isChecking) return <div className="flex items-center justify-center min-h-[60vh]"><Loader2 className="w-6 h-6 animate-spin" /></div>;

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <Card className="w-80">
          <CardHeader><CardTitle className="text-base flex items-center gap-2"><Shield className="w-4 h-4" /> Admin Access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Input
              type="password"
              placeholder="Admin secret"
              value={adminInput}
              onChange={e => setAdminInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAdminLogin()}
            />
            <Button className="w-full" onClick={handleAdminLogin}>Enter</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 sm:p-8 pb-24 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <Shield className="w-6 h-6 text-amber-400" /> TruthMarket Admin
        </h1>
        <Badge variant="outline" className="text-emerald-400 border-emerald-400/30">Live</Badge>
      </div>

      <Tabs defaultValue="treasury">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="treasury">Treasury</TabsTrigger>
          <TabsTrigger value="ai">AI Markets</TabsTrigger>
          <TabsTrigger value="create">Create</TabsTrigger>
          <TabsTrigger value="override">Override</TabsTrigger>
          <TabsTrigger value="withdrawals">Withdrawals</TabsTrigger>
        </TabsList>

        <TabsContent value="treasury" className="pt-4"><TreasuryPanel /></TabsContent>
        <TabsContent value="ai" className="pt-4"><AIMarketGenerator /></TabsContent>
        <TabsContent value="create" className="pt-4"><CreateMarketPanel /></TabsContent>
        <TabsContent value="override" className="pt-4"><ManualOverridePanel /></TabsContent>
        <TabsContent value="withdrawals" className="pt-4"><WithdrawalPanel /></TabsContent>
      </Tabs>
    </div>
  );
}
