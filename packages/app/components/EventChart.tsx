'use client';

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';

// Mock deterministic data array showing Momentum Volume over time
// In production, this data would come from the `market_snapshots` Supabase table
const mockChartData = [
  { time: '10:00 AM', yesVolume: 400, noVolume: 600 },
  { time: '11:00 AM', yesVolume: 800, noVolume: 650 },
  { time: '12:00 PM', yesVolume: 1200, noVolume: 700 },
  { time: '1:00 PM', yesVolume: 2500, noVolume: 800 },
  { time: '2:00 PM', yesVolume: 3100, noVolume: 1200 },
  { time: '3:00 PM', yesVolume: 4800, noVolume: 1500 },
  { time: '4:00 PM', yesVolume: 5200, noVolume: 1900 },
];

export function EventChart() {
  return (
    <Card className="w-full bg-card/50 backdrop-blur-sm border-muted overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-lg font-medium tracking-tight font-sans">Momentum</CardTitle>
        <CardDescription>Real-time liquidity flow (tNGN) over the last 6 hours.</CardDescription>
      </CardHeader>
      <CardContent className="p-0 sm:p-6 sm:pt-0">
        <div className="h-[250px] w-full mt-4">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={mockChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
        </div>
      </CardContent>
    </Card>
  );
}
