import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isAdminRequest } from '@/lib/adminAuth';
import { safeSecretMatch } from '@/lib/safeCompare';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// This endpoint is called weekly by the GitHub Actions cron-heartbeat workflow.
// It publishes a heartbeat transaction to the EscapeHatch smart contract.
// If this stops firing for 30 days, users can call emergencyWithdraw()
// directly on the contract to reclaim their funds — bypassing Opinions.ng.
//
// Accepts either the server-side CRON_SECRET (GitHub Actions) or the admin
// cookie (the manual "fire heartbeat" button in /admin). The admin panel
// no longer carries the cron secret client-side.
export async function POST(request: Request) {
  try {
    const cronSecret = request.headers.get('x-cron-secret');
    const isValidCron = safeSecretMatch(cronSecret, process.env.CRON_SECRET);
    if (!isValidCron && !isAdminRequest(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Log the heartbeat in Supabase
    await supabaseAdmin.from('heartbeat_log').insert({
      fired_at: new Date().toISOString(),
      polygon_tx_hash: null, // Updated once on-chain tx confirms
    });

    // PHASE 3 TODO: also publish this heartbeat on-chain to the EscapeHatch
    // contract (KMS-signed tx via viem/polygon), then backfill
    // heartbeat_log.polygon_tx_hash. Blocked on the contract deployment and
    // KMS key provisioning — the Supabase log above is the source of truth
    // until then. (Illustrative pseudo-code removed; it had drifted from the
    // actual SDK surface and read as if it were real, disabled code.)

    console.log('Heartbeat logged at', new Date().toISOString());
    return NextResponse.json({ success: true }, { status: 200 });

  } catch (error: any) {
    console.error('Heartbeat error:', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
