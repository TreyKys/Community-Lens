import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { marketLockCron, oracleWorker, weeklyHeartbeat, dailyMarketCreation } from '@/inngest/functions';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    dailyMarketCreation,  // 6am daily — creates football, basketball, tennis, esports markets
    marketLockCron,       // every 5min — locks markets at close time
    oracleWorker,         // every 5min — resolves locked markets after result confirmed
    weeklyHeartbeat,      // Sunday midnight — resets escape hatch clock
  ],
});
