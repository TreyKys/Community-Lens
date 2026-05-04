'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Status = 'verifying' | 'completed' | 'failed';

function CallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  // Paystack appends ?reference=... and ?trxref=... — use either.
  const reference = params.get('reference') || params.get('trxref');
  const [status, setStatus] = useState<Status>('verifying');
  const [amount, setAmount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!reference) {
      setStatus('failed');
      setErrorMsg('Missing transaction reference.');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/paystack/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference }),
        });
        const body = await res.json();
        if (cancelled) return;
        if (res.ok && body.status === 'completed') {
          setStatus('completed');
          setAmount(body.tngn_credited || body.amount);
        } else {
          setStatus('failed');
          setErrorMsg(body.message || body.error || 'Payment did not complete.');
        }
      } catch (e: any) {
        if (cancelled) return;
        setStatus('failed');
        setErrorMsg(e.message || 'Network error');
      }
    })();
    return () => { cancelled = true; };
  }, [reference]);

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
            {amount ? `${Number(amount).toLocaleString()} tNGN credited.` : 'Your wallet has been credited.'}
          </p>
          <Button onClick={() => router.push('/')} className="w-full">Back to Odds.ng</Button>
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

export default function PaystackCallbackPage() {
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
