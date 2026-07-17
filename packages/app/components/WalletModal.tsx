'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { Wallet, Loader2, Shield, AlertTriangle, RefreshCw } from 'lucide-react';
import { APPROVED_BANKS } from '@/lib/banks';

export function WalletModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [balance, setBalance] = useState<number>(0);
  const [bonusBalance, setBonusBalance] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountName, setAccountName] = useState('');
  const [isDepositLoading, setIsDepositLoading] = useState(false);
  const [isWithdrawLoading, setIsWithdrawLoading] = useState(false);
  const [isRefreshingDeposit, setIsRefreshingDeposit] = useState(false);

  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user?.id) fetchBalance(session.user.id);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (s?.user?.id) fetchBalance(s.user.id);
    });
    return () => subscription.unsubscribe();
  }, []);

  const fetchBalance = useCallback(async (userId: string) => {
    const { data } = await supabase
      .from('users')
      .select('tngn_balance, bonus_balance')
      .eq('id', userId)
      .single();
    if (data) {
      setBalance(data.tngn_balance || 0);
      setBonusBalance(data.bonus_balance || 0);
    }
  }, []);

  const handleCardDeposit = async () => {
    const amount = Number(depositAmount);
    if (!amount || amount < 500) {
      toast({ title: 'Minimum deposit is ₦500', variant: 'destructive' });
      return;
    }
    if (!session?.user) {
      toast({ title: 'Please sign in first', variant: 'destructive' });
      return;
    }
    setIsDepositLoading(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      if (!s?.access_token) throw new Error('Sign in to deposit');
      // Squad is the only active payment provider — Paystack scrapped per board decision.
      const res = await fetch('/api/squad/initiate-card', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const body = await res.json();
      const redirectUrl = body.authorizationUrl || body.checkoutUrl;
      if (!res.ok || !redirectUrl) throw new Error(body.error || 'Could not start payment');
      window.location.href = redirectUrl;
    } catch (e: any) {
      toast({ title: 'Payment failed to start', description: e.message, variant: 'destructive' });
      setIsDepositLoading(false);
    }
  };

  // Manual re-check for a deposit that paid but hasn't shown up yet. Hits the
  // owner-gated /api/squad/refresh, which re-verifies with Squad and credits
  // if confirmed — the user's own lever to un-stick a lagging deposit instead
  // of waiting for the reconcile sweep.
  const handleRefreshDeposit = async () => {
    if (!session?.user) {
      toast({ title: 'Please sign in first', variant: 'destructive' });
      return;
    }
    setIsRefreshingDeposit(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      if (!s?.access_token) throw new Error('Sign in to continue');
      const res = await fetch('/api/squad/refresh', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}), // no ref → most recent still-open deposit
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 404 || body?.status === 'not_found') {
        toast({ title: 'No pending deposit', description: 'Nothing waiting to be credited.' });
      } else if (body?.status === 'completed') {
        toast({ title: 'Deposit credited', description: body.tngn_credited ? `₦${Math.round(Number(body.tngn_credited)).toLocaleString()} is in your wallet.` : 'Your wallet has been updated.' });
        if (session?.user?.id) fetchBalance(session.user.id);
      } else if (body?.status === 'failed') {
        toast({ title: 'Payment did not complete', description: body.message || 'No charge stands.', variant: 'destructive' });
      } else if (body?.status === 'needs_review') {
        toast({ title: 'Needs review', description: 'Support will confirm this deposit shortly.', variant: 'destructive' });
      } else {
        toast({ title: 'Still processing', description: body.message || 'Check back in a moment.' });
      }
    } catch (e: any) {
      toast({ title: 'Could not refresh', description: e.message, variant: 'destructive' });
    } finally {
      setIsRefreshingDeposit(false);
    }
  };

  const handleWithdraw = async () => {
    const amount = Number(withdrawAmount);
    if (amount < 200) {
      toast({ title: 'Minimum withdrawal is 200 tNGN', variant: 'destructive' });
      return;
    }
    if (!bankCode || accountNumber.length !== 10) {
      toast({ title: 'Enter valid bank details', description: '10-digit NUBAN required', variant: 'destructive' });
      return;
    }
    if (!accountName.trim()) {
      toast({ title: 'Enter your account name', description: 'Exactly as it appears in your bank', variant: 'destructive' });
      return;
    }
    if (amount > balance) {
      toast({ title: 'Insufficient balance', variant: 'destructive' });
      return;
    }
    setIsWithdrawLoading(true);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      const res = await fetch('/api/withdraw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s?.access_token}` },
        body: JSON.stringify({ amountTNGN: amount, bankCode, accountNumber, accountName: accountName.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Withdrawal failed');
      toast({
        title: 'Withdrawal received',
        description: data.message || 'Withdrawals are reviewed within 24 hours.',
      });
      if (session?.user?.id) fetchBalance(session.user.id);
      setIsOpen(false);
      setWithdrawAmount('');
      setBankCode('');
      setAccountNumber('');
      setAccountName('');
    } catch (err: any) {
      toast({ title: 'Withdrawal failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsWithdrawLoading(false);
    }
  };

  const wp = (() => {
    const n = Number(withdrawAmount);
    if (!n || n < 200) return null;
    return { fees: ((n * 0.01) + 50).toFixed(0), naira: (n - n * 0.01 - 50).toFixed(0) };
  })();

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-muted/50 border-muted hover:bg-muted">
          <Wallet className="h-4 w-4" />
          {balance > 0 ? `₦${balance.toLocaleString()} tNGN` : 'Wallet'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px] max-h-[92vh] overflow-y-auto border-muted">
        <DialogHeader>
          <DialogTitle>Wallet</DialogTitle>
          <DialogDescription>
            Balance: <strong>₦{balance.toLocaleString()} tNGN</strong>
            {bonusBalance > 0 && <span className="text-amber-400"> + ₦{bonusBalance.toLocaleString()} bonus</span>}
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="deposit" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="deposit">Deposit</TabsTrigger>
            <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          </TabsList>

          {/* ── DEPOSIT ─────────────────────────────────────────────────── */}
          <TabsContent value="deposit" className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Pay with card, bank transfer, or USSD. You&apos;ll be redirected to a secure hosted checkout.
            </p>
            <div className="space-y-2">
              <Label>Amount (₦)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₦</span>
                <Input
                  type="number"
                  placeholder="Min ₦500"
                  value={depositAmount}
                  onChange={e => setDepositAmount(e.target.value)}
                  min={500}
                  className="pl-8"
                />
              </div>
            </div>

            {Number(depositAmount) >= 500 && (
              <div className="text-[10px] text-muted-foreground bg-muted/30 rounded-lg p-3 border border-border/50">
                New here? Get up to ₦5,000 back in protection credits every Monday.
              </div>
            )}

            <Button
              onClick={handleCardDeposit}
              disabled={isDepositLoading || !depositAmount || Number(depositAmount) < 500}
              className="w-full h-12 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold"
            >
              {isDepositLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Redirecting to checkout…
                </span>
              ) : (
                <span>Continue to Secure Checkout</span>
              )}
            </Button>
            {isDepositLoading && (
              <div className="h-1 bg-muted/50 rounded-full overflow-hidden">
                <div className="h-full w-full progress-stripe" />
              </div>
            )}

            <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
              <Shield className="w-3 h-3" /> Secured by Squad · Card · Bank · USSD
            </p>

            {/* Paid but not showing? Let the user force a re-check + credit. */}
            <Button
              variant="ghost"
              onClick={handleRefreshDeposit}
              disabled={isRefreshingDeposit}
              className="w-full h-9 text-xs text-muted-foreground hover:text-foreground"
            >
              {isRefreshingDeposit ? (
                <span className="flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Checking your last deposit…</span>
              ) : (
                <span className="flex items-center gap-2"><RefreshCw className="w-3.5 h-3.5" /> Paid but not showing? Re-check my deposit</span>
              )}
            </Button>
            <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed border-t border-border/30 pt-3">
              Trouble with your deposit? Email{' '}
              <a href="mailto:opng@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">opng@neurodevlabs.cloud</a>
              {' '}or{' '}
              <a href="mailto:hello@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">hello@neurodevlabs.cloud</a>
            </p>
          </TabsContent>

          {/* ── WITHDRAW ────────────────────────────────────────────────── */}
          <TabsContent value="withdraw" className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">Withdraw to any approved Nigerian bank. Reviewed within 24 hours.</p>
            <div className="space-y-2">
              <Label>Amount (tNGN)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₦</span>
                <Input
                  type="number"
                  placeholder={`Min 200 (max ${balance.toLocaleString()})`}
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  min={200}
                  max={balance}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Bank</Label>
              <Select value={bankCode} onValueChange={setBankCode}>
                <SelectTrigger>
                  <SelectValue placeholder="Select your bank" />
                </SelectTrigger>
                <SelectContent>
                  {APPROVED_BANKS.map(b => (
                    <SelectItem key={b.code} value={b.code}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Account Number</Label>
              <Input
                type="text"
                placeholder="10-digit NUBAN"
                maxLength={10}
                value={accountNumber}
                onChange={e => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              />
            </div>
            <div className="space-y-2">
              <Label>Account Name</Label>
              <Input
                type="text"
                placeholder="Exactly as it appears in your bank"
                value={accountName}
                onChange={e => setAccountName(e.target.value)}
                autoComplete="off"
              />
              <p className="text-[10px] text-muted-foreground">
                Double-check this — withdrawals to the wrong account can&apos;t be reversed.
              </p>
            </div>

            {wp && (
              <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/30 rounded-lg p-3 border border-border/50">
                <div className="flex justify-between font-semibold text-foreground">
                  <span>You receive</span><span className="text-emerald-400">₦{wp.naira}</span>
                </div>
                {Number(withdrawAmount) >= 500000 && (
                  <div className="flex items-start gap-1.5 text-amber-400 pt-1 border-t border-border/50 mt-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>Large withdrawal — security audit required (up to 24 hours)</span>
                  </div>
                )}
              </div>
            )}
            <Button
              onClick={handleWithdraw}
              disabled={isWithdrawLoading || !withdrawAmount || !bankCode || accountNumber.length !== 10 || !accountName.trim()}
              variant="secondary"
              className="w-full"
            >
              {isWithdrawLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Processing...</> : 'Withdraw to Bank'}
            </Button>
            <p className="text-[11px] text-muted-foreground/80 text-center leading-relaxed border-t border-border/30 pt-3">
              Withdrawal stuck or missing? Email{' '}
              <a href="mailto:opng@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">opng@neurodevlabs.cloud</a>
              {' '}or{' '}
              <a href="mailto:hello@neurodevlabs.cloud" className="text-emerald-400 underline underline-offset-2 hover:text-emerald-300">hello@neurodevlabs.cloud</a>
            </p>
          </TabsContent>
        </Tabs>

        <div className="pt-2 border-t text-center">
          <p className="text-xs text-muted-foreground">
            External wallet?{' '}
            <button className="underline underline-offset-2 hover:text-foreground transition-colors">
              Connect via RainbowKit
            </button>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
