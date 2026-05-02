'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Wallet, Loader2, Shield, AlertTriangle } from 'lucide-react';

export function WalletModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [balance, setBalance] = useState<number>(0);
  const [bonusBalance, setBonusBalance] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [isDepositLoading, setIsDepositLoading] = useState(false);
  const [isWithdrawLoading, setIsWithdrawLoading] = useState(false);

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

  const handleCardDeposit = async (gateway: 'paystack' | 'squad') => {
    const amount = Number(depositAmount);
    if (!amount || amount < 100) {
      toast({ title: 'Minimum deposit is ₦100', variant: 'destructive' });
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
      const path = gateway === 'paystack' ? '/api/paystack/initiate' : '/api/squad/initiate-card';
      const res = await fetch(path, {
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

  const handleWithdraw = async () => {
    const amount = Number(withdrawAmount);
    if (amount < 1000) {
      toast({ title: 'Minimum withdrawal is 1,000 tNGN', variant: 'destructive' });
      return;
    }
    if (!bankCode || accountNumber.length !== 10) {
      toast({ title: 'Enter valid bank details', description: '10-digit NUBAN required', variant: 'destructive' });
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
        body: JSON.stringify({ amountTNGN: amount, bankCode, accountNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Withdrawal failed');
      if (data.status === 'under_review') {
        toast({ title: 'Withdrawal under review', description: data.message });
      } else {
        toast({
          title: 'Withdrawal initiated ✅',
          description: `₦${data.nairaToReceive?.toLocaleString()} arriving in your bank within 2 hours.`,
        });
        if (session?.user?.id) fetchBalance(session.user.id);
      }
      setIsOpen(false);
      setWithdrawAmount('');
      setBankCode('');
      setAccountNumber('');
    } catch (err: any) {
      toast({ title: 'Withdrawal failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsWithdrawLoading(false);
    }
  };

  const dp = (() => {
    const n = Number(depositAmount);
    if (!n || n < 100) return null;
    return { tNGN: (n * 0.985).toFixed(2), bonus: (n * 0.01).toFixed(2) };
  })();

  const wp = (() => {
    const n = Number(withdrawAmount);
    if (!n || n < 100) return null;
    return { fees: ((n * 0.015) + 100).toFixed(0), naira: (n - n * 0.015 - 100).toFixed(0) };
  })();

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-muted/50 border-muted hover:bg-muted">
          <Wallet className="h-4 w-4" />
          {balance > 0 ? `₦${balance.toLocaleString()} tNGN` : 'Cashier'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[420px] border-muted">
        <DialogHeader>
          <DialogTitle>Cashier</DialogTitle>
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
                  placeholder="Min ₦100"
                  value={depositAmount}
                  onChange={e => setDepositAmount(e.target.value)}
                  min={100}
                  className="pl-8"
                />
              </div>
            </div>

            {dp && (
              <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/30 rounded-lg p-3 border border-border/50">
                <div className="flex justify-between"><span>You receive</span><span className="text-emerald-400">{dp.tNGN} tNGN</span></div>
                <div className="flex justify-between"><span>Bonus credit</span><span className="text-amber-400">+₦{dp.bonus}</span></div>
              </div>
            )}

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Choose payment provider</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() => handleCardDeposit('paystack')}
                  disabled={isDepositLoading || !depositAmount || Number(depositAmount) < 100}
                  variant="outline"
                  className="h-auto py-3 flex-col gap-1"
                >
                  <span className="font-semibold">Paystack</span>
                  <span className="text-[10px] text-muted-foreground font-normal">Card · Bank · USSD</span>
                </Button>
                <Button
                  onClick={() => handleCardDeposit('squad')}
                  disabled={isDepositLoading || !depositAmount || Number(depositAmount) < 100}
                  variant="outline"
                  className="h-auto py-3 flex-col gap-1"
                >
                  <span className="font-semibold">Squad</span>
                  <span className="text-[10px] text-muted-foreground font-normal">Card · Bank · USSD</span>
                </Button>
              </div>
              {isDepositLoading && (
                <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1 pt-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Redirecting to checkout…
                </p>
              )}
            </div>

            <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
              <Shield className="w-3 h-3" /> Secured by Paystack &amp; Squad
            </p>
          </TabsContent>

          {/* ── WITHDRAW ────────────────────────────────────────────────── */}
          <TabsContent value="withdraw" className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">Withdraw to any Nigerian bank. Arrives in 1-2 hours.</p>
            <div className="space-y-2">
              <Label>Amount (tNGN)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">₦</span>
                <Input
                  type="number"
                  placeholder={`Min 1,000 (max ${balance.toLocaleString()})`}
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  min={1000}
                  max={balance}
                  className="pl-8"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Bank Code</Label>
                <Input
                  type="text"
                  placeholder="e.g. 058"
                  value={bankCode}
                  onChange={e => setBankCode(e.target.value.replace(/\D/g, ''))}
                  maxLength={6}
                />
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
            </div>
            {wp && (
              <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/30 rounded-lg p-3 border border-border/50">
                <div className="flex justify-between"><span>Fees (spread + ₦100)</span><span>₦{wp.fees}</span></div>
                <div className="flex justify-between font-semibold text-foreground border-t border-border/50 pt-1.5 mt-1.5">
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
              disabled={isWithdrawLoading || !withdrawAmount || !bankCode || accountNumber.length !== 10}
              variant="secondary"
              className="w-full"
            >
              {isWithdrawLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Processing...</> : 'Withdraw to Bank'}
            </Button>
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
