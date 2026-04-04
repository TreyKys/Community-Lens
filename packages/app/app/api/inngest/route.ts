import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { marketLockCron, oracleWorker, weeklyHeartbeat } from '@/inngest/functions';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [marketLockCron, oracleWorker, weeklyHeartbeat],
});
