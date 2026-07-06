'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Check, AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';

type Status = 'verifying' | 'completed' | 'pending' | 'failed';

// Verify timing knobs. The Squad redirect frequently lands a beat before
// the webhook, so the first verify call may correctly come back "pending"
// while the webhook lands. We poll a handful of times with backoff before
// we give up and tell the user "still processing — your balance will
// update shortly". Total ceiling ~18s so users aren't watching a spinner
// forever.
const ATTEMPTS = 6;
const ATTEMPT_DELAY_MS = [0, 1500, 2500, 3500, 4500, 5500] as const;
const PER_ATTEMPT_TIMEOUT_MS = 12_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// Inline support line, shown on every state of this page. Deposits are
// the place users get most spooked when something looks off, so we keep
// the contact route visible regardless of outcome — including the happy
// path, just in case the credited amount looks wrong.
function SupportLine() {
  return (
    <p className="text-[11px] text-muted-foreground/80 leading-relaxed border-t border-border/30 pt-3 mt-2">
      Any problem with your deposit? Email{' '}
      <a href="mailto:opng@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">opng@neurodevlabs.cloud</a>
      {' '}or{' '}
      <a href="mailto:hello@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">hello@neurodevlabs.cloud</a>
    </p>
  );
}

async function postVerify(reference: string, signal: AbortSignal): Promise<any> {
  const res = await fetch('/api/squad/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
    signal,
  });
  // Always try to parse — verify returns JSON for both success and failure.
  let body: any = null;
  try { body = await res.json(); } catch { /* ignore — handled below */ }
  return { res, body };
}

function CallbackContent() {
  const router = useRouter();
  const params = useSearchParams();
  // Squad sends the ref under a few different keys depending on flow
  // (hosted checkout vs VA vs redirect). Accept all of them.
  const ref =
    params.get('ref') ||
    params.get('transaction_ref') ||
    params.get('reference');

  const [status, setStatus] = useState<Status>('verifying');
  const [amount, setAmount] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // React 18 Strict Mode + dev hot reload re-fires effects. Without this
  // guard the verify call would race itself; the server CAS protects
  // against double-credit but we still don't want to spam the endpoint.
  const startedRef = useRef(false);
  const [reloadKey, setReloadKey] = useState(0);

  const runVerification = useCallback(async () => {
    if (!ref) {
      setStatus('failed');
      setErrorMsg('Missing transaction reference. If you were charged, contact support.');
      return;
    }

    setStatus('verifying');
    setErrorMsg(null);

    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const delay = ATTEMPT_DELAY_MS[attempt] ?? 5_000;
      if (delay > 0) await sleep(delay);

      const ctrl = new AbortController();
      const timeoutId = setTimeout(() => ctrl.abort(), PER_ATTEMPT_TIMEOUT_MS);
      try {
        const { res, body } = await postVerify(ref, ctrl.signal);
        clearTimeout(timeoutId);

        // Success — we credited (or someone else did). Trigger a server
        // re-render so the balance in the app shell refreshes on the
        // user's next navigation.
        if (res.ok && body?.status === 'completed') {
          setStatus('completed');
          setAmount(Number(body.tngn_credited ?? body.amount ?? 0) || null);
          try { router.refresh(); } catch { /* no-op */ }
          return;
        }

        // Squad confirmed it failed — terminal, no retry.
        const explicitFailure =
          typeof body?.status === 'string' && body.status.toLowerCase().startsWith('failed');
        if (explicitFailure) {
          setStatus('failed');
          setErrorMsg(body?.message || body?.error || 'Payment did not complete.');
          return;
        }

        // 4xx from our server (bad ref, validation, etc.) — terminal.
        if (res.status >= 400 && res.status < 500) {
          setStatus('failed');
          setErrorMsg(body?.error || 'We could not verify this payment.');
          return;
        }

        // Anything else — webhook hasn't landed yet, Squad still settling,
        // or our 5xx. Fall through to the next attempt.
      } catch (e: any) {
        clearTimeout(timeoutId);
        // Timeout / network blip — keep retrying. Last attempt falls through.
        if (attempt === ATTEMPTS - 1) {
          // continue to the pending fallback below
        }
      }
    }

    // Ran out of attempts without a terminal answer — soft-pending state.
    // The webhook will finish crediting on its own; we tell the user the
    // balance will update shortly rather than scaring them with "failed".
    setStatus('pending');
  }, [ref, router]);

  useEffect(() => {
    if (!ref) {
      setStatus('failed');
      setErrorMsg('Missing transaction reference. If you were charged, contact support.');
      return;
    }
    if (startedRef.current && reloadKey === 0) return;
    startedRef.current = true;

    // Light-touch session refresh. If the user finished checkout in a new
    // tab their session may have drifted; this keeps the post-deposit
    // navigation friction-free without blocking the verify call.
    supabase.auth.getSession().catch(() => { /* non-critical */ });

    runVerification();
  }, [ref, reloadKey, runVerification]);

  const checkAgain = () => {
    startedRef.current = false;
    setReloadKey(k => k + 1);
  };

  return (
    <div className="w-full max-w-md rounded-xl border border-border/50 bg-card p-8 text-center space-y-4">
      {status === 'verifying' && (
        <>
          <Loader2 className="w-10 h-10 animate-spin mx-auto text-muted-foreground" />
          <h1 className="text-lg font-semibold">Verifying your payment…</h1>
          <p className="text-sm text-muted-foreground">
            Confirming with Squad. This usually takes a few seconds.
          </p>
          {ref && (
            <p className="text-[10px] text-muted-foreground/70 font-mono break-all">
              ref: {ref}
            </p>
          )}
          <SupportLine />
        </>
      )}

      {status === 'completed' && (
        <>
          <Check className="w-10 h-10 mx-auto text-emerald-400" />
          <h1 className="text-lg font-semibold">Deposit received</h1>
          <p className="text-sm text-muted-foreground">
            {amount
              ? `₦${Number(amount).toLocaleString()} credited to your wallet.`
              : 'Your wallet has been credited.'}
          </p>
          <Button onClick={() => router.push('/markets')} className="w-full">
            Continue to markets
          </Button>
          <SupportLine />
        </>
      )}

      {status === 'pending' && (
        <>
          <AlertTriangle className="w-10 h-10 mx-auto text-amber-400" />
          <h1 className="text-lg font-semibold">Still processing…</h1>
          <p className="text-sm text-muted-foreground">
            Squad hasn&apos;t confirmed the payment yet. Your balance will update
            automatically within a minute or two — you can leave this page.
          </p>
          {ref && (
            <p className="text-[10px] text-muted-foreground/70 font-mono break-all">
              ref: {ref}
            </p>
          )}
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={checkAgain} className="w-full">
              <RefreshCw className="w-4 h-4 mr-2" />
              Check again
            </Button>
            <Button onClick={() => router.push('/markets')} className="w-full">
              Back to markets
            </Button>
          </div>
          <SupportLine />
        </>
      )}

      {status === 'failed' && (
        <>
          <AlertTriangle className="w-10 h-10 mx-auto text-destructive" />
          <h1 className="text-lg font-semibold">Payment not completed</h1>
          <p className="text-sm text-muted-foreground">{errorMsg || 'No charge was made.'}</p>
          {ref && (
            <p className="text-[10px] text-muted-foreground/70 font-mono break-all">
              ref: {ref}
            </p>
          )}
          <p className="text-[11px] text-muted-foreground/80">
            Quote this reference if you contact support.
          </p>
          <div className="flex flex-col gap-2">
            <Button variant="outline" onClick={checkAgain} className="w-full">
              <RefreshCw className="w-4 h-4 mr-2" />
              Try again
            </Button>
            <Button onClick={() => router.push('/markets')} className="w-full">
              Back to markets
            </Button>
          </div>
          <SupportLine />
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
