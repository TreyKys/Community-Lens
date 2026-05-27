import { isAdminRequest } from '@/lib/adminAuth';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// We need to trigger this via a cron job (e.g. Vercel Cron)
// This will simulate the "Autonomous Squadron" logic loop
export async function GET(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');


    const isValidCron = cronSecret === process.env.CRON_SECRET;
    const isValidAdmin = isAdminRequest(request);

    if (!isValidCron && !isValidAdmin) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 1. Fetch bots that belong to the 'autonomous_amm' cohort
    const { data: bots, error: botsError } = await supabaseAdmin
      .from('users')
      .select('id, tngn_balance, bot_behavior')
      .eq('is_bot', true)
      .eq('bot_cohort', 'autonomous_amm');

    if (botsError || !bots) {
      return NextResponse.json({ error: 'Failed to fetch bots' }, { status: 500 });
    }

    if (bots.length === 0) {
      return NextResponse.json({ message: 'No autonomous bots found' }, { status: 200 });
    }

    // Fetch active markets
    const { data: markets, error: marketsError } = await supabaseAdmin
      .from('markets')
      .select('id, status, closes_at')
      .eq('status', 'open');

    if (marketsError || !markets || markets.length === 0) {
      return NextResponse.json({ message: 'No open markets found' }, { status: 200 });
    }

    // Here we map behaviors and execute actions randomly to simulate behavior matrix
    // In a full implementation, you would write granular logic for each bot behavior archetype
    const actions = bots.map(async (bot) => {
        const behavior = bot.bot_behavior;
        // Basic example: randomly select a market
        const randomMarket = markets[Math.floor(Math.random() * markets.length)];

        // Skip if bot doesn't have balance
        if (bot.tngn_balance < 100) return null;

        // Example: The Drip Feeder
        if (behavior === 'The Drip Feeder' || !behavior) {
            const stake = 500;
            if (bot.tngn_balance < stake) return null;

            return supabaseAdmin.rpc('place_bet', {
              p_user_id: bot.id,
              p_market_id: randomMarket.id,
              p_outcome_index: Math.round(Math.random()),
              p_stake_amount: stake,
              p_entry_rake: stake * 0.015,
              p_is_jackpot_eligible: false
            });
        }

        return null;
    });

    const results = await Promise.allSettled(actions.filter(a => a !== null));
    const successful = results.filter(r => r.status === 'fulfilled' && !r.value?.error).length;

    return NextResponse.json({ success: true, processed: bots.length, successfulBets: successful }, { status: 200 });

  } catch (error: any) {
    console.error('Swarm tick error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
