'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  Area, AreaChart, Bar, BarChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis, Cell
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { BarChart3, TrendingUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

const OPTION_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'];

interface EventChartProps {
  marketId: string | number;
  options?: string[];
}

type ChartMode = 'distribution' | 'snapshots';

interface DistributionPoint {
  option: string;
  amount: number;
  percentage: number;
}

interface TimelinePoint {
  time: string;
  [key: string]: number | string;
}

export function EventChart({ marketId, options = [] }: EventChartProps) {
  const [mode, setMode] = useState<ChartMode>('distribution');
  const [isLoading, setIsLoading] = useState(false);
  const [timeline, setTimeline] = useState<TimelinePoint[]>([]);
  const [distribution, setDistribution] = useState<DistributionPoint[]>([]);
  const [totalPool, setTotalPool] = useState(0);
  const [chartOptions, setChartOptions] = useState<string[]>(options);
  // marketStatus gates whether we expose pool ₦ at all. While the market
  // is open we only show % share + the distribution graph — disclosing
  // tiny pool sizes pre-lock tips traders off and looks weak on small
  // markets. Once locked/resolved the total is no longer actionable, so
  // it's safe (and useful) to show.
  const [marketStatus, setMarketStatus] = useState<string>('open');

  const fetchChartData = useCallback(async (m: ChartMode) => {
    if (!marketId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`/api/markets/chart?marketId=${marketId}&mode=${m}`);
      if (!res.ok) throw new Error('Chart data unavailable');
      const data = await res.json();

      if (m === 'distribution') {
        setTimeline(data.timeline || []);
        setDistribution(data.distribution || []);
        setTotalPool(data.totalPool || 0);
        if (data.options?.length) setChartOptions(data.options);
        if (data.status) setMarketStatus(data.status);
      } else {
        setTimeline(data.timeline || []);
      }
    } catch {
      // Fail silently — chart is non-critical
    } finally { setIsLoading(false); }
  }, [marketId]);

  useEffect(() => { fetchChartData(mode); }, [mode, fetchChartData]);

  const handleModeChange = (newMode: ChartMode) => {
    setMode(newMode);
  };

  // Apply the standard 10% pool rake before showing any user-facing total.
  // Single source of truth is lib/displayPool.ts — never render the raw pool.
  const displayedPool = Math.round(totalPool * 0.9);
  const totalPoolStr = displayedPool > 1000
    ? `₦${(displayedPool / 1000).toFixed(1)}k`
    : `₦${displayedPool.toLocaleString()}`;
  const isPoolRevealed = marketStatus === 'locked' || marketStatus === 'resolved';

  return (
    <Card className="w-full bg-card/50 backdrop-blur-sm border-muted overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {mode === 'distribution' ? 'Prediction Distribution' : 'Volume Over Time'}
            </CardTitle>
            <CardDescription className="text-xs">
              {mode === 'distribution'
                ? (isPoolRevealed ? `Total pool: ${totalPoolStr} tNGN` : 'Live consensus by share')
                : 'Liquidity flow over time'}
            </CardDescription>
          </div>
          {/* Volume tab is inherently ₦-denominated — only useful once the
              pool is revealed. While the market is open we keep the chart
              focused on % share and hide the toggle entirely. */}
          {isPoolRevealed && (
            <div className="flex items-center gap-1 bg-muted/50 rounded-lg p-1">
              <Button
                size="sm"
                variant={mode === 'distribution' ? 'secondary' : 'ghost'}
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => handleModeChange('distribution')}
              >
                <BarChart3 className="w-3 h-3" />
                Bets
              </Button>
              <Button
                size="sm"
                variant={mode === 'snapshots' ? 'secondary' : 'ghost'}
                className="h-7 px-2.5 text-xs gap-1"
                onClick={() => handleModeChange('snapshots')}
              >
                <TrendingUp className="w-3 h-3" />
                Volume
              </Button>
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0 sm:p-6 sm:pt-0">
        {isLoading ? (
          <div className="h-[220px] flex flex-col items-center justify-center gap-2 px-4">
            <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
            <div className="h-1 w-32 rounded-full bg-muted/40 overflow-hidden">
              <div className="h-full w-full progress-stripe" />
            </div>
          </div>
        ) : mode === 'distribution' ? (
          <>
            {/* Stacked bar progress for each option */}
            {distribution.length > 0 ? (
              <div className="px-4 sm:px-0 mt-4 space-y-3">
                {distribution.map((d, i) => (
                  <div key={d.option}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-2.5 h-2.5 rounded-full"
                          style={{ background: OPTION_COLORS[i % OPTION_COLORS.length] }}
                        />
                        <span className="font-medium text-foreground">{d.option}</span>
                      </div>
                      <div className="flex items-center gap-3 text-muted-foreground">
                        <span className="font-bold text-foreground">{d.percentage}%</span>
                      </div>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-700"
                        style={{
                          width: `${d.percentage}%`,
                          background: OPTION_COLORS[i % OPTION_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-[100px] flex items-center justify-center">
                <p className="text-sm text-muted-foreground">No predictions yet. Be the first.</p>
              </div>
            )}

            {/* Timeline chart if we have time-based data.
                Values from the API are now per-option % share at each
                hourly bucket (sums to 100). Stacking with stackId fills
                the chart to a 100% band, so the y-axis stays meaningful
                regardless of how big the pool grows. */}
            {timeline.length > 1 && (
              <div className="h-[160px] w-full mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline} margin={{ top: 4, right: 10, left: 0, bottom: 0 }} stackOffset="expand">
                    <defs>
                      {chartOptions.map((opt, i) => (
                        <linearGradient key={opt} id={`color_${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={OPTION_COLORS[i % OPTION_COLORS.length]} stopOpacity={0.5} />
                          <stop offset="95%" stopColor={OPTION_COLORS[i % OPTION_COLORS.length]} stopOpacity={0.1} />
                        </linearGradient>
                      ))}
                    </defs>
                    <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} dy={8} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                      tickFormatter={v => `${Math.round(v * 100)}%`}
                      domain={[0, 1]}
                      ticks={[0, 0.25, 0.5, 0.75, 1]}
                      dx={-4}
                      width={36}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(v: any, name: any) => [`${Number(v).toFixed(1)}%`, name as string]}
                    />
                    {chartOptions.map((opt, i) => (
                      <Area
                        key={opt}
                        type="monotone"
                        dataKey={opt}
                        name={opt}
                        stackId="1"
                        stroke={OPTION_COLORS[i % OPTION_COLORS.length]}
                        strokeWidth={1.5}
                        fillOpacity={1}
                        fill={`url(#color_${i})`}
                      />
                    ))}
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </>
        ) : (
          /* Volume / snapshot mode */
          <div className="h-[220px] w-full mt-4">
            {timeline.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={timeline} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorVol" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} dy={8} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `₦${(v/1000).toFixed(1)}k`} dx={-4} width={44} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                    formatter={(v: any) => [`₦${Number(v).toLocaleString()}`, 'Pool Volume']}
                  />
                  <Area type="monotone" dataKey="volume" name="Pool Volume" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorVol)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm text-muted-foreground">No volume data yet.</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
