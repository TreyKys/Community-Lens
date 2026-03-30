'use client';

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';

export function EventChart({ marketId }: { marketId: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [chartData, setChartData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      if (!marketId) return;
      try {
        const { data } = await supabase
          .from('market_snapshots')
          .select('created_at, yes_volume, no_volume')
          .eq('market_id', marketId)
          .order('created_at', { ascending: true });

        if (data && data.length > 0) {
          const formattedData = data.map(row => {
            const date = new Date(row.created_at);
            return {
              time: date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
              yesVolume: row.yes_volume,
              noVolume: row.no_volume
            };
          });
          setChartData(formattedData);
        } else {
          setChartData([]);
        }
      } catch (err) {
        console.error("Failed to fetch chart data:", err);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [marketId]);

  return (
    <Card className="w-full bg-card/50 backdrop-blur-sm border-muted overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-medium tracking-tight font-sans">Momentum</CardTitle>
        <CardDescription>Real-time liquidity flow (tNGN).</CardDescription>
      </CardHeader>
      <CardContent className="p-0 sm:p-6 sm:pt-0">
        <div className="h-[250px] w-full mt-4">
          {loading ? (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground">
              Loading Data...
            </div>
          ) : chartData.length === 0 ? (
            <div className="w-full h-full flex items-center justify-center text-muted-foreground border border-dashed border-muted rounded-md bg-muted/20">
              <span className="font-medium text-sm">Awaiting Market Data</span>
            </div>
          ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="colorYes" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="colorNo" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#ef4444" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#ef4444" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="time"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                dy={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={(value) => `₦${(value / 1000).toFixed(1)}k`}
                dx={-10}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)',
                }}
                itemStyle={{ color: 'hsl(var(--foreground))', fontSize: '14px', fontWeight: 500 }}
                labelStyle={{ color: 'hsl(var(--muted-foreground))', fontSize: '12px', marginBottom: '4px' }}
              />
              <Area
                type="monotone"
                dataKey="yesVolume"
                name="Yes / Home"
                stroke="#3b82f6"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorYes)"
              />
              <Area
                type="monotone"
                dataKey="noVolume"
                name="No / Away"
                stroke="#ef4444"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#colorNo)"
              />
            </AreaChart>
          </ResponsiveContainer>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
