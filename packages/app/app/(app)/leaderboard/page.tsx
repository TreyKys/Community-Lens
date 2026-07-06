'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Trophy, Crown, Sparkles, Clock, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pollWhileVisible } from '@/lib/pollWhileVisible';

// Public leaderboard — flipped live from the previous waitlist
// teaser. Daily / Weekly / All-time tabs, top-3 podium, then a full
// list of ranked predictors. Driven by /api/leaderboard, which serves
// whatever an admin last published (POST /api/admin/leaderboard/publish)
// rather than recomputing live — the admin controls the cadence.

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface Row {
  rank: number;
  userId: string;
  username: string;
  avatarId: number;
  points: number;
  accuracy: number | null;
  resolvedBets: number;
  wonBets: number;
}

type WindowKey = 'daily' | 'weekly' | 'alltime';

const WINDOW_LABEL: Record<WindowKey, string> = {
  daily:   'Today',
  weekly:  'This Week',
  alltime: 'All-Time',
};

// Tier thresholds match lib/displayMultiplier + the share-card tier
// ladder. Keep the badge palette consistent across the product so a
// user who's seen their accuracy card recognises the colour.
function tierFor(accuracy: number | null, resolved: number): { label: string; color: string } {
  if (accuracy == null || resolved < 5) return { label: 'ROOKIE',          color: 'text-slate-400' };
  if (accuracy >= 80)                  return { label: 'PRO FORECASTER',  color: 'text-amber-400' };
  if (accuracy >= 75)                  return { label: 'ELITE',           color: 'text-amber-500' };
  if (accuracy >= 70)                  return { label: 'TOP FORECASTER',  color: 'text-emerald-400' };
  if (accuracy >= 60)                  return { label: 'SHARP',           color: 'text-cyan-400' };
  if (accuracy >= 50)                  return { label: 'RISING',          color: 'text-violet-400' };
  return { label: 'CONTENDER', color: 'text-slate-400' };
}

function Podium({ rows }: { rows: Row[] }) {
  // Lay out top 3 as a #1-centre podium (visual gold standard) only if
  // we actually have 3 entries — otherwise fall back to a left-aligned
  // strip so a brand-new daily board with one entry still looks intentional.
  if (rows.length < 3) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {rows.map(r => <PodiumCard key={r.userId} row={r} />)}
      </div>
    );
  }
  const [first, second, third] = rows;
  return (
    <div className="grid grid-cols-3 gap-3 items-end">
      <div className="pt-6"><PodiumCard row={second} /></div>
      <div><PodiumCard row={first} /></div>
      <div className="pt-10"><PodiumCard row={third} /></div>
    </div>
  );
}

function PodiumCard({ row }: { row: Row }) {
  const tier = tierFor(row.accuracy, row.resolvedBets);
  const podium = row.rank === 1 ? { color: 'text-amber-400',  glow: 'shadow-[0_0_40px_rgba(251,191,36,0.25)]', icon: Crown,    bg: 'bg-amber-500/[0.06] border-amber-500/30' }
              : row.rank === 2 ? { color: 'text-slate-300',  glow: 'shadow-[0_0_30px_rgba(203,213,225,0.15)]', icon: Trophy,   bg: 'bg-slate-500/[0.05] border-slate-500/30' }
              :                  { color: 'text-orange-400', glow: 'shadow-[0_0_30px_rgba(251,146,60,0.18)]', icon: Trophy,   bg: 'bg-orange-500/[0.05] border-orange-500/30' };
  const Icon = podium.icon;
  return (
    <Link href={`/u/${row.userId}`} className="block">
      <Card className={cn('border transition-all hover:scale-[1.02]', podium.bg, podium.glow)}>
        <CardContent className="p-3 text-center space-y-1.5">
          <Icon className={cn('w-5 h-5 mx-auto', podium.color)} />
          <p className={cn('text-[10px] uppercase tracking-[0.12em] font-bold', podium.color)}>#{row.rank}</p>
          <p className="text-sm font-bold truncate">@{row.username}</p>
          <p className="text-lg font-black tabular-nums">{row.points.toLocaleString()}<span className="text-[10px] text-muted-foreground ml-1">pts</span></p>
          {row.accuracy != null && (
            <p className="text-[10px] text-muted-foreground">
              <span className="tabular-nums">{row.accuracy}%</span> accuracy
            </p>
          )}
          <Badge variant="outline" className={cn('text-[9px] border-transparent', tier.color)}>
            {tier.label}
          </Badge>
        </CardContent>
      </Card>
    </Link>
  );
}

function ListRow({ row }: { row: Row }) {
  const tier = tierFor(row.accuracy, row.resolvedBets);
  return (
    <Link href={`/u/${row.userId}`} className="block">
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/40 hover:border-emerald-500/30 hover:bg-emerald-500/[0.03] transition-colors">
        <span className="text-xs font-mono w-7 text-right text-muted-foreground tabular-nums">#{row.rank}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold truncate">@{row.username}</p>
          <p className="text-[10px] text-muted-foreground">
            {row.accuracy != null
              ? <><span className="tabular-nums">{row.accuracy}%</span> accuracy · <span className={tier.color}>{tier.label}</span></>
              : <span className={tier.color}>{tier.label} — building a record</span>}
          </p>
        </div>
        <span className="text-sm font-bold tabular-nums">{row.points.toLocaleString()}<span className="text-[9px] text-muted-foreground ml-1">pts</span></span>
      </div>
    </Link>
  );
}

export default function LeaderboardPage() {
  const [windowKey, setWindowKey] = useState<WindowKey>('weekly');
  const [rows, setRows] = useState<Row[]>([]);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Reload on tab change + a slow visibility-gated poll so a page left
  // open picks up the next admin publish without a manual refresh.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/leaderboard?window=${windowKey}&limit=50`);
        const data = await res.json();
        if (alive) {
          setRows(data.rows || []);
          setPublishedAt(data.publishedAt ?? null);
        }
      } catch {
        if (alive) {
          setRows([]);
          setPublishedAt(null);
        }
      } finally {
        if (alive) setIsLoading(false);
      }
    };
    setIsLoading(true);
    load();
    const cleanup = pollWhileVisible(load, 120_000);
    return () => { alive = false; cleanup(); };
  }, [windowKey]);

  const podiumRows = rows.slice(0, 3);
  const tailRows = rows.slice(3);

  return (
    <div className="relative min-h-screen">
      <div className="fixed inset-0 z-0 pointer-events-none opacity-40">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[500px] rounded-full bg-amber-500/10 blur-[150px]" />
        <div className="absolute bottom-0 right-0 w-[500px] h-[500px] rounded-full bg-emerald-500/10 blur-[150px]" />
      </div>

      <div className="relative z-10 max-w-3xl mx-auto p-4 md:p-8 space-y-5 pb-24">
        <div className="text-center space-y-2 pt-2">
          <Badge className="bg-amber-500/15 text-amber-300 border border-amber-500/30 px-3 py-0.5">
            <Clock className="w-3 h-3 mr-1" /> {publishedAt ? `Updated ${timeAgo(publishedAt)}` : 'Not yet published'}
          </Badge>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
            The <span className="text-amber-400">Leaderboard</span>
          </h1>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            The country&rsquo;s sharpest forecasters, ranked by points. Refreshed periodically, not live.
          </p>
        </div>

        <Tabs value={windowKey} onValueChange={(v) => setWindowKey(v as WindowKey)}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="daily">Today</TabsTrigger>
            <TabsTrigger value="weekly">This Week</TabsTrigger>
            <TabsTrigger value="alltime">All-Time</TabsTrigger>
          </TabsList>

          {(['daily', 'weekly', 'alltime'] as WindowKey[]).map(k => (
            <TabsContent key={k} value={k} className="pt-4 space-y-5">
              {isLoading ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : rows.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <AlertCircle className="w-10 h-10 text-muted-foreground/40 mb-3" />
                  <p className="text-sm text-muted-foreground">
                    {publishedAt
                      ? <>No-one&rsquo;s on the board {WINDOW_LABEL[k].toLowerCase()} yet.</>
                      : <>The board hasn&rsquo;t been published yet.</>}
                  </p>
                  <p className="text-[11px] text-muted-foreground/70 mt-1">
                    {publishedAt ? 'Be the first to land a correct call.' : 'Check back soon.'}
                  </p>
                </div>
              ) : (
                <>
                  <Podium rows={podiumRows} />
                  {tailRows.length > 0 && (
                    <div className="space-y-1.5">
                      <div className="flex items-center gap-2 px-3">
                        <Sparkles className="w-3 h-3 text-emerald-400" />
                        <p className="text-[10px] uppercase tracking-[0.14em] font-bold text-muted-foreground">
                          Top {Math.min(rows.length, 50)} · {WINDOW_LABEL[k]}
                        </p>
                      </div>
                      {tailRows.map(r => <ListRow key={r.userId} row={r} />)}
                    </div>
                  )}
                </>
              )}
            </TabsContent>
          ))}
        </Tabs>

        <p className="text-[10px] text-center text-muted-foreground/60 pt-2">
          1 pt per ₦250 staked · 1 pt per ₦100 profit · referral bonuses count too.
        </p>
      </div>
    </div>
  );
}
