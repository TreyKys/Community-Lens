'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Status = 'verifying' | 'completed' | 'failed' | 'pending';

function CallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  const ref = params.get('ref') || params.get('transaction_ref') || params.get('reference');
  const [status, setStatus] = useState<Status>('verifying');
  const [amount, setAmount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!ref) {
      setStatus('failed');
      setErrorMsg('Missing transaction reference.');
      return;
    }

    let cancelled = false;
    // Call our verify endpoint immediately — this confirms the charge with
    // Squad server-to-server and credits the balance without waiting for
    // the webhook to arrive.
    (async () => {
      try {
        const res = await fetch('/api/squad/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference: ref }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (res.ok && body.status === 'completed') {
          setStatus('completed');
          setAmount(body.tngn_credited ?? body.amount ?? null);
        } else if (body.status === 'failed' || body.error) {
          setStatus('failed');
          setErrorMsg(body.message || body.error || 'Payment did not complete.');
        } else {
          // Squad hasn't settled yet — show a soft-pending state.
          setStatus('pending');
        }
      } catch (e: any) {
        if (cancelled) return;
        setStatus('failed');
        setErrorMsg(e.message || 'Network error');
      }
    })();

    return () => { cancelled = true; };
  }, [ref]);

  return (
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
            {amount ? `${Number(amount).toLocaleString()} tNGN credited to your wallet.` : 'Your wallet has been credited.'}
          </p>
          <Button onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
        </>
      )}
      {status === 'pending' && (
        <>
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-400" />
          <h1 className="text-lg font-semibold">Still processing…</h1>
          <p className="text-sm text-muted-foreground">
            Squad hasn&apos;t confirmed the payment yet. Your balance will update shortly.
          </p>
          <Button variant="outline" onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
        </>
      )}
      {status === 'failed' && (
        <>
          <AlertTriangle className="w-10 h-10 mx-auto text-destructive" />
          <h1 className="text-lg font-semibold">Payment not completed</h1>
          <p className="text-sm text-muted-foreground">{errorMsg || 'No charge was made.'}</p>
          <Button onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
        </>
      )}
    </div>
  );
}

export default function SquadCallbackPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <Suspense fallback={
        <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-8 text-center space-y-4">
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">Loading…</h1>
        </div>
      }>
        <CallbackContent />
      </Suspense>
    </div>
  );
}
