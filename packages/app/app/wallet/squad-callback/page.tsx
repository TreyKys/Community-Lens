'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Status = 'verifying' | 'completed' | 'pending' | 'failed';

export default function SquadCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const ref = params.get('ref');
  const [status, setStatus] = useState<Status>('verifying');
  const [amount, setAmount] = useState<number | null>(null);

  useEffect(() => {
    if (!ref) {
      setStatus('failed');
      return;
    }
    let elapsed = 0;
    const id = setInterval(async () => {
      elapsed += 3;
      const { data } = await supabase
        .from('squad_transactions')
        .select('status, amount_ngn, tngn_credited')
        .eq('transaction_ref', ref)
        .single();

      if (data?.status === 'completed') {
        setStatus('completed');
        setAmount(data.tngn_credited || data.amount_ngn);
        clearInterval(id);
      } else if (data?.status?.startsWith('failed')) {
        setStatus('failed');
        clearInterval(id);
      } else if (elapsed >= 60) {
        setStatus('pending');
        clearInterval(id);
      }
    }, 3000);
    return () => clearInterval(id);
  }, [ref]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-8 text-center space-y-4">
        {status === 'verifying' && (
          <>
            <Loader2 className="w-10 h-10 animate-spin mx-auto text-muted-foreground" />
            <h1 className="text-lg font-semibold">Verifying your payment…</h1>
            <p className="text-sm text-muted-foreground">This usually takes a few seconds.</p>
          </>
        )}
        {status === 'completed' && (
          <>
            <Check className="w-10 h-10 mx-auto text-emerald-400" />
            <h1 className="text-lg font-semibold">Deposit received</h1>
            <p className="text-sm text-muted-foreground">
              {amount ? `₦${Number(amount).toLocaleString()} credited.` : 'Your wallet has been credited.'}
            </p>
            <Button onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
          </>
        )}
        {status === 'pending' && (
          <>
            <AlertTriangle className="w-10 h-10 mx-auto text-amber-400" />
            <h1 className="text-lg font-semibold">Still waiting on Squad…</h1>
            <p className="text-sm text-muted-foreground">
              If you completed the payment, your balance will update shortly. You can close this page.
            </p>
            <Button variant="outline" onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
          </>
        )}
        {status === 'failed' && (
          <>
            <AlertTriangle className="w-10 h-10 mx-auto text-destructive" />
            <h1 className="text-lg font-semibold">Payment not completed</h1>
            <p className="text-sm text-muted-foreground">
              {ref ? 'The payment was cancelled or failed. No charge was made.' : 'Missing transaction reference.'}
            </p>
            <Button onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
          </>
        )}
      </div>
    </div>
  );
}
