import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /api/jackpot — returns current jackpot pool size + carryover info
export async function GET() {
  try {
    // The jackpot pool = sum of entry rakes from qualifying slips this week
    // A qualifying slip has is_jackpot_eligible = true AND was placed this week
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay()); // Monday
    weekStart.setHours(0, 0, 0, 0);

    const { data: weeklyBets } = await supabaseAdmin
      .from('user_bets')
      .select('stake_tngn, entry_rake_tngn, user_id, market_id')
      .eq('is_jackpot_eligible', true)
      .gte('placed_at', weekStart.toISOString());

    // Count unique qualifying users and their distinct market coverage
    const userMarkets: Record<string, Set<number>> = {};
    let totalWeeklyRake = 0;

    for (const bet of weeklyBets || []) {
      if (!userMarkets[bet.user_id]) userMarkets[bet.user_id] = new Set();
      userMarkets[bet.user_id].add(bet.market_id);
      totalWeeklyRake += bet.entry_rake_tngn || 0;
    }

    // Count users with 6+ unique markets (full jackpot slip)
    const fullyQualified = Object.values(userMarkets).filter(m => m.size >= 6).length;

    // Carryover — sum of unclaimed jackpot pools from previous weeks
    // Stored in a jackpot_pool table
    const { data: carryover } = await supabaseAdmin
      .from('jackpot_pool')
      .select('amount')
      .eq('status', 'active')
      .single();

    const carryoverAmount = carryover?.amount || 0;
    const totalPool = carryoverAmount + (totalWeeklyRake * 0.5); // 50% of qualifying rakes go to jackpot

    return NextResponse.json({
      totalPool: Math.round(totalPool),
      weeklyRake: Math.round(totalWeeklyRake),
      carryover: Math.round(carryoverAmount),
      qualifiedSlips: fullyQualified,
      weekStart: weekStart.toISOString(),
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
