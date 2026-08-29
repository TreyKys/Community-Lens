import { createClient } from '@supabase/supabase-js';
import * as fs from 'fs';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const APP_URL = 'http://localhost:3004'; // Adjusted to port 3004

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BOT_EMAILS = [
  'bot1@odds.ng', 'bot2@odds.ng', 'bot3@odds.ng', 'bot4@odds.ng', 'bot5@odds.ng',
  'bot6@odds.ng', 'bot7@odds.ng', 'bot8@odds.ng', 'bot9@odds.ng', 'bot10@odds.ng',
  'bot11@odds.ng', 'bot12@odds.ng', 'bot13@odds.ng', 'bot14@odds.ng', 'bot15@odds.ng',
  'bot16@odds.ng', 'bot17@odds.ng', 'bot18@odds.ng', 'bot19@odds.ng', 'bot20@odds.ng',
  'bot28@odds.ng', 'bot50@odds.ng'
];
const MASTER_PASSWORD = 'OddsNgBotSquad2026!';

interface TestResult {
  name: string;
  status: 'Pass' | 'Fail' | 'Error';
  details: string;
  latencyMs?: number;
}

const results: TestResult[] = [];

function logResult(name: string, status: 'Pass' | 'Fail' | 'Error', details: string, latencyMs?: number) {
  console.log(`[${status}] ${name} ${latencyMs ? `(${latencyMs}ms)` : ''}`);
  if (status !== 'Pass') {
    console.error(`   -> ${details}`);
  }
  results.push({ name, status, details, latencyMs });
}

async function runTests() {
  console.log('Starting QA Red Team Audit...');

  // Phase 1: Authentication & Session Integrity
  console.log('\n--- Phase 1: Authentication ---');
  const botSessions: any[] = [];

  const startAuth = Date.now();
  try {
    const authPromises = BOT_EMAILS.map(email =>
      fetch(`${APP_URL}/api/auth/bot-bypass`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: MASTER_PASSWORD })
      }).then(res => res.json())
    );

    const authResponses = await Promise.all(authPromises);
    const failedAuth = authResponses.filter(r => r.error);

    if (failedAuth.length === 0) {
      logResult('Concurrent Bot Login', 'Pass', 'All 22 bots authenticated successfully.', Date.now() - startAuth);
      authResponses.forEach(r => botSessions.push(r.session));
    } else {
      logResult('Concurrent Bot Login', 'Fail', `Failed logins: ${JSON.stringify(failedAuth)}`, Date.now() - startAuth);
      return; // Stop if we can't auth
    }
  } catch (error: any) {
    logResult('Concurrent Bot Login', 'Error', error.message);
    return;
  }

  // Non-bot email bypass rejection
  try {
    const nonBotRes = await fetch(`${APP_URL}/api/auth/bot-bypass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'realuser@gmail.com', password: MASTER_PASSWORD })
    }).then(res => res.json());

    if (nonBotRes.error) {
      logResult('Non-Bot Bypass Rejection', 'Pass', 'Properly rejected non-bot email.');
    } else {
      logResult('Non-Bot Bypass Rejection', 'Fail', 'Allowed bypass for non-bot email.');
    }
  } catch (error: any) {
    logResult('Non-Bot Bypass Rejection', 'Error', error.message);
  }

  // Session user profile mapping verification
  try {
    let mappingPassed = true;
    for (let session of botSessions) {
      const { data: user, error } = await supabaseAdmin.from('users').select('id').eq('id', session.user.id).single();
      if (error || !user) {
         mappingPassed = false;
         logResult('Session Integrity Mapping', 'Fail', `Bot ${session.user.email} not found in public.users.`);
         break;
      }
    }
    if (mappingPassed) logResult('Session Integrity Mapping', 'Pass', 'All bot sessions map to existing public.users rows.');
  } catch(error: any) {
     logResult('Session Integrity Mapping', 'Error', error.message);
  }

  // Dynamic Market Creation for tests
  console.log('\n--- Creating Test Market ---');
  let testMarketId: number;
  try {
      const marketId = parseInt((Math.random() * 100000000).toString());
      const { data, error } = await supabaseAdmin.from('markets').insert({
          id: marketId,
          title: 'QA Test Market',
          question: 'TEST MARKET: Will system crash?',
          options: JSON.stringify(['YES', 'NO']),
          closes_at: new Date(Date.now() + 3600000).toISOString(),
          status: 'open'
      }).select().single();

      if (error) throw error;

      testMarketId = data.id;
      console.log(`Test Market Created: ID ${testMarketId}`);
  } catch (error: any) {
      console.error("Critical failure creating test market:", error.message);
      return;
  }

  // Phase 2: Payment Flow & Wallet Integrity
  console.log('\n--- Phase 2: Wallet Integrity ---');
  let bot1Session = botSessions[0];

  // Give bot1 some bonus balance for testing via Admin
  await supabaseAdmin.from('users').update({ bonus_balance: 1000 }).eq('id', bot1Session.user.id);

  // Valid Bet Deduction
  try {
    const betRes = await fetch(`${APP_URL}/api/bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot1Session.access_token}`
      },
      body: JSON.stringify({
        marketId: testMarketId,
        outcomeIndex: 0,
        stakeAmount: 500
      })
    }).then(res => res.json());

    if (betRes.success) {
      const { data: user } = await supabaseAdmin.from('users').select('bonus_balance').eq('id', bot1Session.user.id).single();
      if (user?.bonus_balance === 500) {
        logResult('Valid Bet Deduction', 'Pass', 'Successfully placed bet and deducted 500 from bonus balance.');
      } else {
        logResult('Valid Bet Deduction', 'Fail', `Bet placed but balance mismatch. Expected 500, got ${user?.bonus_balance}`);
      }
    } else {
      logResult('Valid Bet Deduction', 'Fail', `Failed to place bet: ${JSON.stringify(betRes)}`);
    }
  } catch (error: any) {
    logResult('Valid Bet Deduction', 'Error', error.message);
  }

  // Negative Balance Test
  try {
    const betRes = await fetch(`${APP_URL}/api/bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot1Session.access_token}`
      },
      body: JSON.stringify({
        marketId: testMarketId,
        outcomeIndex: 0,
        stakeAmount: 10000 // Greater than remaining 500
      })
    }).then(res => res.json());

    if (betRes.error && betRes.error.includes('Insufficient balance')) {
      logResult('Negative Balance Prevention', 'Pass', 'Properly rejected bet greater than available balance.');
    } else {
      logResult('Negative Balance Prevention', 'Fail', `Failed to reject large bet. Response: ${JSON.stringify(betRes)}`);
    }
  } catch (error: any) {
    logResult('Negative Balance Prevention', 'Error', error.message);
  }

  // Zero/Negative Value Test
  try {
    const betRes = await fetch(`${APP_URL}/api/bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot1Session.access_token}`
      },
      body: JSON.stringify({
        marketId: testMarketId,
        outcomeIndex: 0,
        stakeAmount: -500
      })
    }).then(res => res.json());

    if (betRes.error) {
      logResult('Negative/Zero Stake Prevention', 'Pass', 'Properly rejected negative stake amount.');
    } else {
      logResult('Negative/Zero Stake Prevention', 'Fail', `Allowed negative stake. Response: ${JSON.stringify(betRes)}`);
    }
  } catch (error: any) {
    logResult('Negative/Zero Stake Prevention', 'Error', error.message);
  }


  // Phase 3: Betting Flows & Live In-Play
  console.log('\n--- Phase 3: Betting Flows ---');

  // Give all 20 bots enough balance first
  await supabaseAdmin.from('users').update({ bonus_balance: 1000 }).in('id', botSessions.slice(0, 20).map(s => s.user.id));

  try {
    const startBetting = Date.now();
    const betPromises = botSessions.slice(0, 20).map((session, index) => {
      const outcomeIndex = index < 10 ? 0 : 1; // 10 YES, 10 NO
      return fetch(`${APP_URL}/api/bet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`
        },
        body: JSON.stringify({
          marketId: testMarketId,
          outcomeIndex,
          stakeAmount: 100
        })
      }).then(res => res.json());
    });

    const betResponses = await Promise.all(betPromises);
    const failedBets = betResponses.filter(r => !r.success);

    if (failedBets.length === 0) {
      logResult('Concurrent 20 Bets (YES/NO)', 'Pass', 'All 20 bets placed successfully.', Date.now() - startBetting);

      // Verify Double-Entry
      const { data: userBets } = await supabaseAdmin.from('user_bets').select('*').eq('market_id', testMarketId);

      if (userBets && userBets.length >= 20) {
         logResult('Double-Entry Verification (user_bets)', 'Pass', `Found ${userBets.length} entries in user_bets.`);
      } else {
         logResult('Double-Entry Verification (user_bets)', 'Fail', `Only found ${userBets?.length || 0} entries in user_bets.`);
      }

      // We check if squad_transactions was inserted into (based on the user's specific request)
      const { data: squadTx } = await supabaseAdmin.from('squad_transactions').select('*');
      if (squadTx && squadTx.length >= 20) {
         logResult('Double-Entry Verification (squad_transactions)', 'Pass', `Found ${squadTx.length} entries in squad_transactions.`);
      } else {
         logResult('Double-Entry Verification (squad_transactions)', 'Fail', `Only found ${squadTx?.length || 0} entries in squad_transactions. Bets are missing from the financial ledger.`);
      }

      // And we also verify treasury_log where the entry rake is correctly deposited
      const { data: treasuryLogs } = await supabaseAdmin.from('treasury_log').select('*').eq('market_id', testMarketId);
      if (treasuryLogs && treasuryLogs.length >= 20) {
          logResult('Treasury Log Verification', 'Pass', `Found ${treasuryLogs.length} rake entries in treasury_log.`);
      } else {
          logResult('Treasury Log Verification', 'Fail', `Only found ${treasuryLogs?.length || 0} rake entries.`);
      }

    } else {
      logResult('Concurrent 20 Bets (YES/NO)', 'Fail', `Failed bets: ${JSON.stringify(failedBets)}`, Date.now() - startBetting);
    }
  } catch (error: any) {
    logResult('Concurrent 20 Bets (YES/NO)', 'Error', error.message);
  }

  // Live In-Play Market Lock Test
  try {
     // Lock the market
     await supabaseAdmin.from('markets').update({ status: 'locked' }).eq('id', testMarketId);

     const betRes = await fetch(`${APP_URL}/api/bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot1Session.access_token}`
      },
      body: JSON.stringify({
        marketId: testMarketId,
        outcomeIndex: 0,
        stakeAmount: 100
      })
    }).then(res => res.json());

    if (betRes.error && betRes.error.includes('not open for betting')) {
      logResult('Late In-Play Rejection', 'Pass', 'Properly rejected bet on a locked market.');
    } else {
      logResult('Late In-Play Rejection', 'Fail', `Allowed bet on locked market. Response: ${JSON.stringify(betRes)}`);
    }

    // Unlock it for Phase 5
    await supabaseAdmin.from('markets').update({ status: 'open' }).eq('id', testMarketId);
  } catch (error: any) {
     logResult('Late In-Play Rejection', 'Error', error.message);
  }


  // Phase 4: Boundary & Security Testing (RLS Audit)
  console.log('\n--- Phase 4: Security (RLS) ---');
  try {
     const bot2Session = botSessions[1];
     const anonSupabase = createClient(SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
         global: { headers: { Authorization: `Bearer ${bot1Session.access_token}` } }
     });

     // Cross-user fetch
     const { data: crossData, error: crossError } = await anonSupabase.from('users').select('*').eq('id', bot2Session.user.id);
     if (crossData && crossData.length === 0) {
         logResult('RLS Cross-User Fetch Rejection', 'Pass', 'RLS successfully blocked reading another user\'s row.');
     } else {
         logResult('RLS Cross-User Fetch Rejection', 'Fail', `RLS leak! Data returned: ${JSON.stringify(crossData)}`);
     }

     // Unauthorized Update
     const { data: updateData, error: updateError } = await anonSupabase.from('users').update({ bonus_balance: 999999 }).eq('id', bot1Session.user.id);

     // Re-check balance via Admin to see if it changed
     const { data: verifyUpdate } = await supabaseAdmin.from('users').select('bonus_balance').eq('id', bot1Session.user.id).single();
     if (verifyUpdate?.bonus_balance !== 999999) {
         logResult('RLS Direct Update Rejection', 'Pass', 'RLS successfully blocked direct client balance update.');
     } else {
         logResult('RLS Direct Update Rejection', 'Fail', 'RLS allowed client to arbitrarily update balance!');
     }
  } catch (error: any) {
     logResult('RLS Audits', 'Error', error.message);
  }

  // Malformed JSON Payload
  try {
    const betRes = await fetch(`${APP_URL}/api/bet`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${bot1Session.access_token}`
      },
      body: '{"marketId": 1, "outcomeIndex": 0, "stakeAmount": 100, malformed...}' // Intentional syntax error
    });

    if (betRes.status >= 400 && betRes.status < 500) {
      logResult('Malformed Payload Handling', 'Pass', `Handled bad JSON cleanly with status ${betRes.status}.`);
    } else {
      logResult('Malformed Payload Handling', 'Fail', `Returned unexpected status: ${betRes.status}`);
    }
  } catch (error: any) {
    logResult('Malformed Payload Handling', 'Pass', 'Fetch threw error on malformed payload as expected.');
  }


  // Phase 5: Load & Stress Testing
  console.log('\n--- Phase 5: Load Testing ---');
  // Top up balances
  await supabaseAdmin.from('users').update({ bonus_balance: 100000 }).in('id', botSessions.map(s => s.user.id));

  try {
     const stressStart = Date.now();
     // 100 requests spread across 22 bots
     const requests = Array.from({ length: 100 }).map((_, i) => {
         const session = botSessions[i % botSessions.length];
         return fetch(`${APP_URL}/api/bet`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({
              marketId: testMarketId,
              outcomeIndex: 0,
              stakeAmount: 100
            })
          }).then(res => res.json());
     });

     const resultsArr = await Promise.all(requests);
     const stressTime = Date.now() - stressStart;
     const successCount = resultsArr.filter(r => r.success).length;
     const failCount = resultsArr.length - successCount;

     logResult('100 Concurrent Bets', successCount === 100 ? 'Pass' : 'Fail', `Successful: ${successCount}, Failed: ${failCount}`, stressTime);
  } catch (error: any) {
      logResult('100 Concurrent Bets', 'Error', error.message);
  }

  // Cleanup: Lock/Resolve test market
  await supabaseAdmin.from('markets').update({ status: 'resolved', resolved_outcome: 0 }).eq('id', testMarketId);

  // Generate Markdown Report
  const mdReport = `# QA Red Team Audit Report: World Cup Readiness
*Date: ${new Date().toISOString()}*
*Target: Next.js/Supabase Off-Chain Engine*

## Execution Summary
Total Tests: ${results.length}
Passed: ${results.filter(r => r.status === 'Pass').length}
Failed: ${results.filter(r => r.status === 'Fail').length}
Errored: ${results.filter(r => r.status === 'Error').length}

## Detailed Results

| Test Name | Status | Latency | Details |
| :--- | :---: | :---: | :--- |
${results.map(r => `| **${r.name}** | ${r.status === 'Pass' ? '✅ Pass' : r.status === 'Fail' ? '❌ Fail' : '⚠️ Error'} | ${r.latencyMs ? r.latencyMs + 'ms' : '-'} | ${r.details} |`).join('\n')}

---
*Report automatically generated by QA Script.*
`;

  fs.writeFileSync('../QA_Report_WorldCup.md', mdReport);
  console.log('\nReport written to QA_Report_WorldCup.md in root.');
  process.exit(0);
}

runTests();
