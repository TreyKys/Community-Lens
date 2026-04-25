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

  const totalPoolStr = totalPool > 1000
    ? `₦${(totalPool / 1000).toFixed(1)}k`
    : `₦${totalPool.toLocaleString()}`;

  return (
    <Card className="w-full bg-card/50 backdrop-blur-sm border-muted overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {mode === 'distribution' ? 'Bet Distribution' : 'Volume Over Time'}
            </CardTitle>
            <CardDescription className="text-xs">
              {mode === 'distribution'
                ? `Total pool: ${totalPoolStr} tNGN`
                : 'Liquidity flow over time'}
            </CardDescription>
          </div>
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
        </div>
      </CardHeader>

      <CardContent className="p-0 sm:p-6 sm:pt-0">
        {isLoading ? (
          <div className="h-[220px] flex items-center justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
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
                        <span>₦{d.amount.toLocaleString()}</span>
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
                <p className="text-sm text-muted-foreground">No bets placed yet. Be the first.</p>
              </div>
            )}

            {/* Timeline chart if we have time-based data */}
            {timeline.length > 1 && (
              <div className="h-[160px] w-full mt-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={timeline} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      {chartOptions.map((opt, i) => (
                        <linearGradient key={opt} id={`color_${i}`} x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor={OPTION_COLORS[i % OPTION_COLORS.length]} stopOpacity={0.25} />
                          <stop offset="95%" stopColor={OPTION_COLORS[i % OPTION_COLORS.length]} stopOpacity={0} />
                        </linearGradient>
                      ))}
                    </defs>
                    <XAxis dataKey="time" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} dy={8} />
                    <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }} tickFormatter={v => `₦${(v/1000).toFixed(0)}k`} dx={-4} width={40} />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: '8px', fontSize: '12px' }}
                      formatter={(v: any, name: any) => [`₦${Number(v).toLocaleString()}`, name as string]}
                    />
                    {chartOptions.map((opt, i) => (
                      <Area
                        key={opt}
                        type="monotone"
                        dataKey={opt}
                        name={opt}
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
