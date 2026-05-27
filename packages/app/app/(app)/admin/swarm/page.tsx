'use client';

import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Shield, Zap, Activity, AlertTriangle, Users, Bot, RefreshCw, BarChart3, PieChart } from 'lucide-react';

export default function SwarmCommanderPage() {
  const [loading, setLoading] = useState(false);
  const [activeBots, setActiveBots] = useState(0);
  const [report, setReport] = useState<any>(null);

  useEffect(() => {
    // In a real app, you'd fetch initial data here
    setActiveBots(30);
  }, []);

  const runTest = async (testType: string) => {
    setLoading(true);
    setReport(null);
    try {
      const res = await fetch('/api/admin/swarm/stress-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ testType, marketId: 1 }), // Using 1 as dummy market ID
      });
      const data = await res.json();
      if (res.ok) {
        setReport(data.report);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Failed to execute test');
    } finally {
      setLoading(false);
    }
  };

  const tickSwarm = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/cron/swarm-tick?dev=true');
      const data = await res.json();
      if (res.ok) {
        alert(`Swarm Tick successful: ${data.successfulBets} bets placed by ${data.processed} bots.`);
      } else {
        alert(`Error: ${data.error}`);
      }
    } catch (err) {
      alert('Failed to execute swarm tick');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto p-4 sm:p-8 pb-24 space-y-6">
      <div className="flex items-center justify-between border-b pb-4">
        <div>
            <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2 text-primary">
            <Bot className="w-8 h-8 text-emerald-500" /> Swarm Commander
            </h1>
            <p className="text-muted-foreground mt-1">Autonomous AMM & Load Testing HUD</p>
        </div>
        <div className="flex gap-4">
            <div className="text-right">
                <p className="text-xs text-muted-foreground uppercase tracking-wider font-bold">Autonomous Squadron</p>
                <div className="flex items-center justify-end gap-2 text-xl font-mono">
                    <span className="relative flex h-3 w-3">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                    </span>
                    {activeBots} Online
                </div>
            </div>
            <Button variant="outline" onClick={tickSwarm} disabled={loading} className="gap-2">
                <RefreshCw className="w-4 h-4" /> Manual Tick
            </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Telemetry Panel */}
        <Card className="md:col-span-2">
            <CardHeader className="bg-muted/30 border-b">
                <CardTitle className="text-lg flex items-center gap-2">
                    <Activity className="w-5 h-5" /> Telemetry & PnL
                </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div className="p-4 rounded-xl border bg-card">
                        <p className="text-xs text-muted-foreground mb-1 uppercase font-semibold tracking-wider">Avg Latency</p>
                        <p className="text-2xl font-mono">42<span className="text-sm text-muted-foreground ml-1">ms</span></p>
                    </div>
                    <div className="p-4 rounded-xl border bg-card">
                        <p className="text-xs text-muted-foreground mb-1 uppercase font-semibold tracking-wider">TPS (Peak)</p>
                        <p className="text-2xl font-mono">1,204</p>
                    </div>
                    <div className="p-4 rounded-xl border bg-card border-emerald-500/30">
                        <p className="text-xs text-emerald-500 mb-1 uppercase font-semibold tracking-wider flex items-center gap-1"><PieChart className="w-3 h-3"/> Squadron PnL</p>
                        <p className="text-2xl font-mono text-emerald-500">+12.4K</p>
                    </div>
                    <div className="p-4 rounded-xl border bg-card">
                        <p className="text-xs text-muted-foreground mb-1 uppercase font-semibold tracking-wider">Global Invariant</p>
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-sm py-1 mt-1 font-mono">
                            BALANCED
                        </Badge>
                    </div>
                </div>
            </CardContent>
        </Card>

        {/* Action Panel */}
        <Card>
             <CardHeader className="bg-destructive/10 border-b border-destructive/20">
                <CardTitle className="text-lg flex items-center gap-2 text-destructive">
                    <Zap className="w-5 h-5" /> Stress Tests
                </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-2">
                <Button
                    variant="outline"
                    className="w-full justify-start text-left hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                    onClick={() => runTest('concurrency_spike')}
                    disabled={loading}
                >
                    <div className="flex flex-col items-start gap-1">
                        <span className="font-bold">1. Concurrency Spike</span>
                        <span className="text-xs text-muted-foreground font-normal">200 bots placing YES at exact same ms.</span>
                    </div>
                </Button>
                <Button
                    variant="outline"
                    className="w-full justify-start text-left hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                    onClick={() => runTest('double_spend')}
                    disabled={loading}
                >
                    <div className="flex flex-col items-start gap-1">
                        <span className="font-bold">2. Double Spend Attack</span>
                        <span className="text-xs text-muted-foreground font-normal">Attempt to spend more than balance.</span>
                    </div>
                </Button>
                <Button
                    variant="outline"
                    className="w-full justify-start text-left hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30"
                    onClick={() => runTest('fractional_kobo_leak')}
                    disabled={loading}
                >
                    <div className="flex flex-col items-start gap-1">
                        <span className="font-bold">3. Fractional Kobo Leak</span>
                        <span className="text-xs text-muted-foreground font-normal">10,000 random fractional txs.</span>
                    </div>
                </Button>
            </CardContent>
        </Card>
      </div>

      {/* Reports Panel */}
      {report && (
         <Card className="border-emerald-500/30">
            <CardHeader className="bg-emerald-500/5">
                <CardTitle className="text-emerald-500 flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5" /> Diagnostic Report: {report.test_type}
                </CardTitle>
            </CardHeader>
            <CardContent className="p-6">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
                     <div>
                        <p className="text-sm text-muted-foreground">Status</p>
                        <p className="font-mono text-emerald-500">{report.status.toUpperCase()}</p>
                    </div>
                    <div>
                        <p className="text-sm text-muted-foreground">Transactions (Logged / Attempted)</p>
                        <p className="font-mono">{report.total_tx_logged} / {report.total_tx_attempted}</p>
                    </div>
                    <div>
                        <p className="text-sm text-muted-foreground">Peak Latency</p>
                        <p className="font-mono">{report.peak_latency_ms} ms</p>
                    </div>
                    <div>
                        <p className="text-sm text-muted-foreground">Edge Cases</p>
                        <p className="font-mono text-emerald-500">{report.edge_cases_passed ? 'PASSED' : 'FAILED'}</p>
                    </div>
                </div>
                <div className="bg-muted/50 rounded-xl p-4 font-mono text-xs overflow-auto">
                    <pre>{JSON.stringify(report.report_data, null, 2)}</pre>
                </div>
            </CardContent>
        </Card>
      )}

      {/* Analytics For Humans */}
      <Card>
        <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
                <Users className="w-5 h-5 text-blue-500" /> Human Analytics (Phase 2 Alpha Prep)
            </CardTitle>
        </CardHeader>
        <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                 <div className="space-y-2">
                    <h3 className="font-bold text-sm tracking-wide uppercase text-muted-foreground border-b pb-2">Market Liquidity Heatmap</h3>
                    <div className="space-y-3 pt-2">
                        <div>
                            <div className="flex justify-between text-xs mb-1"><span>EPL</span> <span className="font-mono">45%</span></div>
                            <div className="h-2 w-full bg-muted rounded-full overflow-hidden"><div className="h-full bg-blue-500 w-[45%]"></div></div>
                        </div>
                        <div>
                            <div className="flex justify-between text-xs mb-1"><span>Naija Politics</span> <span className="font-mono">30%</span></div>
                            <div className="h-2 w-full bg-muted rounded-full overflow-hidden"><div className="h-full bg-green-500 w-[30%]"></div></div>
                        </div>
                         <div>
                            <div className="flex justify-between text-xs mb-1"><span>Crypto</span> <span className="font-mono">25%</span></div>
                            <div className="h-2 w-full bg-muted rounded-full overflow-hidden"><div className="h-full bg-yellow-500 w-[25%]"></div></div>
                        </div>
                    </div>
                </div>
                <div className="space-y-2">
                    <h3 className="font-bold text-sm tracking-wide uppercase text-muted-foreground border-b pb-2">Conversion & Bust Metrics</h3>
                    <div className="pt-2 space-y-4">
                        <div className="flex items-center justify-between">
                            <span className="text-sm">Bust Velocity (Avg)</span>
                            <span className="font-mono font-bold text-destructive">4.2 Days</span>
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-sm">Rollover Conversion</span>
                            <span className="font-mono font-bold text-emerald-500">12.5%</span>
                        </div>
                    </div>
                </div>
                <div className="space-y-2">
                    <h3 className="font-bold text-sm tracking-wide uppercase text-muted-foreground border-b pb-2">Whale Tracker</h3>
                    <div className="pt-2 space-y-2">
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-mono">0x4a...9b2</span>
                            <span className="text-emerald-500 font-mono">+₦450K</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-mono">0x9c...1a4</span>
                            <span className="text-emerald-500 font-mono">+₦210K</span>
                        </div>
                        <div className="flex items-center justify-between text-sm">
                            <span className="font-mono">0x2f...8d1</span>
                            <span className="text-destructive font-mono">-₦180K</span>
                        </div>
                    </div>
                </div>
            </div>
        </CardContent>
      </Card>
    </div>
  );
}
