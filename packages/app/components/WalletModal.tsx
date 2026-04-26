'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Wallet, Loader2, Shield, AlertTriangle, Copy, Check, Building2, CreditCard } from 'lucide-react';

declare global {
  interface Window {
    PaystackPop?: any;
  }
}

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
  const [paystackReady, setPaystackReady] = useState(false);
  const [nuban, setNuban] = useState<{ accountNumber: string; accountName: string; bankName: string | null } | null>(null);
  const [nubanLoading, setNubanLoading] = useState(false);
  const [nubanError, setNubanError] = useState<string | null>(null);
  const [phoneRequired, setPhoneRequired] = useState(false);
  const [phoneInput, setPhoneInput] = useState('');
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  // Load Paystack inline script
  useEffect(() => {
    if (window.PaystackPop) { setPaystackReady(true); return; }
    const script = document.createElement('script');
    script.src = 'https://js.paystack.co/v1/inline.js';
    script.async = true;
    script.onload = () => setPaystackReady(true);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

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

  const provisionNuban = useCallback(async (phoneOverride?: string) => {
    if (nuban || nubanLoading) return;
    setNubanLoading(true);
    setNubanError(null);
    try {
      const { data: { session: s } } = await supabase.auth.getSession();
      if (!s?.access_token) throw new Error('Sign in to get a deposit account');
      const res = await fetch('/api/squad/provision-account', {
        method: 'POST',
        headers: { Authorization: `Bearer ${s.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(phoneOverride ? { phone: phoneOverride } : {}),
      });
      const body = await res.json();
      if (!res.ok) {
        if (body.code === 'phone_required') {
          setPhoneRequired(true);
          return;
        }
        throw new Error(body.error || 'Failed to provision account');
      }
      setPhoneRequired(false);
      setNuban({
        accountNumber: body.accountNumber,
        accountName: body.accountName,
        bankName: body.bankName,
      });
    } catch (e: any) {
      setNubanError(e.message || 'Could not load bank details');
    } finally {
      setNubanLoading(false);
    }
  }, [nuban, nubanLoading]);

  const submitPhone = async () => {
    const cleaned = phoneInput.replace(/\D/g, '');
    if (cleaned.length < 10) {
      toast({ title: 'Enter a valid Nigerian phone number', variant: 'destructive' });
      return;
    }
    await provisionNuban(cleaned);
  };

  // Lazy-provision the user's virtual NUBAN once the wallet opens.
  // Stop re-firing once we know the user needs to add a phone, otherwise the
  // effect loops forever and races the user's submitPhone call.
  useEffect(() => {
    if (isOpen && session?.user && !nuban && !nubanLoading && !nubanError && !phoneRequired) {
      provisionNuban();
    }
  }, [isOpen, session, nuban, nubanLoading, nubanError, phoneRequired, provisionNuban]);

  const copyAccountNumber = async () => {
    if (!nuban) return;
    try {
      await navigator.clipboard.writeText(nuban.accountNumber);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleDeposit = () => {
    const amount = Number(depositAmount);
    if (!amount || amount < 500) {
      toast({ title: 'Minimum deposit is ₦500', variant: 'destructive' });
      return;
    }
    if (!session?.user) {
      toast({ title: 'Please sign in first', variant: 'destructive' });
      return;
    }
    if (!paystackReady || !window.PaystackPop) {
      toast({ title: 'Payment system loading...', description: 'Please try again in a moment.' });
      return;
    }

    const paystackFee = Math.min((amount * 0.015) + 100, 2000);
    const totalCharge = Math.round((amount + paystackFee) * 100); // kobo

    setIsDepositLoading(true);

    const handler = window.PaystackPop.setup({
      key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY || 'pk_test_e315d890cc4f59e3596b602f4f1b2ae17c064ec3',
      email: session.user.email,
      amount: totalCharge,
      currency: 'NGN',
      ref: `tm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      metadata: {
        userId: session.user.id,
        custom_fields: [
          { display_name: 'Platform', variable_name: 'platform', value: 'Odds.ng' }
        ]
      },
      callback: (_response: any) => {
        // Webhook handles the actual credit — just update UI optimistically
        toast({
          title: 'Deposit successful! 🎉',
          description: `₦${amount.toLocaleString()} depositing now. Balance updates in a moment.`,
        });
        setIsOpen(false);
        setDepositAmount('');
        setIsDepositLoading(false);
        // Refresh balance after short delay for webhook to process
        setTimeout(() => { if (session?.user?.id) fetchBalance(session.user.id); }, 3000);
      },
      onClose: () => {
        setIsDepositLoading(false);
        toast({ title: 'Deposit cancelled', variant: 'destructive' });
      },
    });

    handler.openIframe();
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
        toast({
          title: 'Withdrawal under review',
          description: data.message,
        });
      } else {
        toast({
          title: 'Withdrawal initiated ✅',
          description: `₦${data.nairaToReceive?.toLocaleString()} arriving in your bank within 2 hours.`,
        });
        fetchBalance(session.user.id);
      }
      setIsOpen(false);
      setWithdrawAmount('');
      setBankCode('');
      setAccountNumber('');
    } catch (err: any) {
      toast({ title: 'Withdrawal failed', description: err.message, variant: 'destructive' });
    } finally { setIsWithdrawLoading(false); }
  };

  // Fee previews
  const depositPreview = () => {
    const n = Number(depositAmount);
    if (!n || n < 100) return null;
    const fee = Math.min((n * 0.015) + 100, 2000);
    return { fee: fee.toFixed(0), total: (n + fee).toFixed(0), tNGN: (n * 0.985).toFixed(2) };
  };

  const withdrawPreview = () => {
    const n = Number(withdrawAmount);
    if (!n || n < 100) return null;
    const spread = n * 0.015;
    const naira = (n - spread - 100);
    return { fees: (spread + 100).toFixed(0), naira: naira.toFixed(0) };
  };

  const dp = depositPreview();
  const wp = withdrawPreview();

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

          <TabsContent value="deposit" className="space-y-4 py-4">
            <Tabs defaultValue="transfer" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="transfer" className="gap-1.5"><Building2 className="w-3.5 h-3.5" /> Bank Transfer</TabsTrigger>
                <TabsTrigger value="card" className="gap-1.5"><CreditCard className="w-3.5 h-3.5" /> Card</TabsTrigger>
              </TabsList>

              <TabsContent value="transfer" className="space-y-3 pt-4">
                <p className="text-sm text-muted-foreground">
                  Send any amount to your dedicated account below. Credit lands in seconds.
                </p>

                {nubanLoading && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center">
                    <Loader2 className="w-4 h-4 animate-spin" /> Generating your account…
                  </div>
                )}

                {nubanError && (
                  <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive space-y-2">
                    <div>{nubanError}</div>
                    <Button size="sm" variant="outline" onClick={() => { setNubanError(null); provisionNuban(); }}>
                      Try again
                    </Button>
                  </div>
                )}

                {phoneRequired && !nuban && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-3 space-y-2">
                    <Label className="text-xs">Add your phone number</Label>
                    <p className="text-xs text-muted-foreground">
                      Required by our bank partner to issue your account. Saved to your profile so you only enter it once.
                    </p>
                    <Input
                      type="tel"
                      placeholder="08012345678"
                      value={phoneInput}
                      onChange={(e) => setPhoneInput(e.target.value)}
                      maxLength={14}
                    />
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={submitPhone}
                      disabled={nubanLoading || phoneInput.replace(/\D/g, '').length < 10}
                    >
                      {nubanLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />Generating…</> : 'Generate my account'}
                    </Button>
                  </div>
                )}

                {nuban && (
                  <div className="rounded-lg border border-border/50 bg-muted/30 p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Account number</div>
                        <div className="text-2xl font-mono font-bold tracking-wider">{nuban.accountNumber}</div>
                      </div>
                      <Button size="icon" variant="ghost" onClick={copyAccountNumber} aria-label="Copy account number">
                        {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      </Button>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground border-t border-border/50 pt-2">
                      <span>Bank</span><span className="text-foreground">{nuban.bankName || '—'}</span>
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Account name</span><span className="text-foreground">{nuban.accountName}</span>
                    </div>
                  </div>
                )}

                <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                  <Shield className="w-3 h-3" /> Powered by Squad
                </p>
              </TabsContent>

              <TabsContent value="card" className="space-y-4 pt-4">
                <p className="text-sm text-muted-foreground">Pay with card via Paystack.</p>
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

                {dp && (
                  <div className="text-xs text-muted-foreground space-y-1.5 bg-muted/30 rounded-lg p-3 border border-border/50">
                    <div className="flex justify-between"><span>Paystack fee</span><span>₦{dp.fee}</span></div>
                    <div className="flex justify-between"><span>Total billed</span><span>₦{dp.total}</span></div>
                    <div className="flex justify-between font-semibold text-foreground border-t border-border/50 pt-1.5 mt-1.5">
                      <span>You receive</span><span className="text-emerald-400">{dp.tNGN} tNGN</span>
                    </div>
                  </div>
                )}

                <Button
                  onClick={handleDeposit}
                  disabled={isDepositLoading || !depositAmount}
                  className="w-full bg-foreground text-background hover:bg-foreground/90 font-semibold"
                >
                  {isDepositLoading ? <><Loader2 className="w-4 h-4 animate-spin mr-2" />Processing...</> : 'Deposit Naira'}
                </Button>
                <p className="text-xs text-center text-muted-foreground flex items-center justify-center gap-1">
                  <Shield className="w-3 h-3" /> Secured by Paystack
                </p>
              </TabsContent>
            </Tabs>
          </TabsContent>

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
