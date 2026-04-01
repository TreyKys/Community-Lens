'use client';

import { useState, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/hooks/use-toast';
import { Wallet } from 'lucide-react';

export function WalletModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [session, setSession] = useState<any>(null);
  const [balance, setBalance] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [bankCode, setBankCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session?.user?.id) fetchBalance(session.user.id);
    });
  }, []);

  const fetchBalance = async (userId: string) => {
    const { data } = await supabase
      .from('users')
      .select('tngn_balance')
      .eq('id', userId)
      .single();
    if (data) setBalance(data.tngn_balance || 0);
  };

  // ── Deposit via Paystack ───────────────────────────────────────────
  // Opens Paystack inline checkout. On success, the Paystack webhook
  // fires to /api/webhooks/paystack which credits the user's tNGN balance.
  // The userId is passed in metadata so the webhook knows who to credit.
  const handleDeposit = async () => {
    if (!depositAmount || isNaN(Number(depositAmount)) || Number(depositAmount) < 500) {
      toast({ title: 'Minimum deposit is ₦500', variant: 'destructive' });
      return;
    }

    if (!session?.user) {
      toast({ title: 'Please sign in first', variant: 'destructive' });
      return;
    }

    setIsLoading(true);

    try {
      const amountNGN = Number(depositAmount);
      // Paystack fee: 1.5% + ₦100 (capped at ₦2,000)
      const paystackFee = Math.min((amountNGN * 0.015) + 100, 2000);
      const totalCharge = amountNGN + paystackFee;

      // ---------------------------------------------------------------
      // PHASE 3 TODO: Replace this UI preview with a real Paystack
      // inline checkout. Example:
      //
      //   const handler = PaystackPop.setup({
      //     key: process.env.NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY,
      //     email: session.user.email,
      //     amount: totalCharge * 100, // kobo
      //     currency: 'NGN',
      //     metadata: { userId: session.user.id },
      //     callback: (response) => {
      //       // Webhook handles the credit — just show success UI here
      //       toast({ title: 'Deposit successful!' });
      //       fetchBalance(session.user.id);
      //     },
      //     onClose: () => {},
      //   });
      //   handler.openIframe();
      // ---------------------------------------------------------------

      // Temporary UI preview for testing
      const tNGNToReceive = amountNGN * (1 - 0.015); // 1.5% spread applied
      toast({
        title: 'Deposit Flow (Test Mode)',
        description: `₦${totalCharge.toLocaleString()} charged → ${tNGNToReceive.toLocaleString()} tNGN credited. Wire up Paystack in Phase 3.`,
      });
      setIsOpen(false);
      setDepositAmount('');
    } catch (error: any) {
      toast({ title: 'Deposit failed', description: error.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  // ── Withdraw to Nigerian Bank ──────────────────────────────────────
  const handleWithdraw = async () => {
    if (!withdrawAmount || Number(withdrawAmount) < 1000) {
      toast({ title: 'Minimum withdrawal is 1,000 tNGN', variant: 'destructive' });
      return;
    }

    if (!bankCode || !accountNumber) {
      toast({ title: 'Please enter your bank details', variant: 'destructive' });
      return;
    }

    if (Number(withdrawAmount) > balance) {
      toast({ title: 'Insufficient balance', variant: 'destructive' });
      return;
    }

    setIsLoading(true);

    try {
      const { data: { session: currentSession } } = await supabase.auth.getSession();

      const res = await fetch('/api/withdraw', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${currentSession?.access_token}`,
        },
        body: JSON.stringify({
          amountTNGN: Number(withdrawAmount),
          bankCode,
          accountNumber,
        }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || 'Withdrawal failed');

      if (data.status === 'under_review') {
        toast({
          title: 'Withdrawal Under Review',
          description: data.message,
        });
      } else {
        toast({
          title: 'Withdrawal Initiated',
          description: `₦${data.nairaToReceive?.toLocaleString()} will arrive in your bank within 1-2 hours.`,
        });
        // Refresh balance
        if (session?.user?.id) fetchBalance(session.user.id);
      }

      setIsOpen(false);
      setWithdrawAmount('');
      setBankCode('');
      setAccountNumber('');
    } catch (error: any) {
      toast({ title: 'Withdrawal failed', description: error.message, variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  // ── Fee preview helpers ───────────────────────────────────────────
  const depositPreview = () => {
    const amount = Number(depositAmount);
    if (!amount) return null;
    const paystackFee = Math.min((amount * 0.015) + 100, 2000);
    const tNGN = (amount - (amount * 0.015)).toFixed(2);
    return { paystackFee: paystackFee.toFixed(2), tNGN, totalCharge: (amount + paystackFee).toFixed(2) };
  };

  const withdrawPreview = () => {
    const amount = Number(withdrawAmount);
    if (!amount) return null;
    const spread = amount * 0.015;
    const naira = (amount - spread - 100).toFixed(2);
    return { fees: (spread + 100).toFixed(2), naira };
  };

  const dp = depositPreview();
  const wp = withdrawPreview();

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className="gap-2 bg-muted/50 border-muted hover:bg-muted">
          <Wallet className="h-4 w-4" />
          {balance > 0 ? `${balance.toLocaleString()} tNGN` : 'Cashier'}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[425px] border-muted">
        <DialogHeader>
          <DialogTitle>Cashier</DialogTitle>
          <DialogDescription>
            Balance: <strong>{balance.toLocaleString()} tNGN</strong>
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="deposit" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="deposit">Deposit</TabsTrigger>
            <TabsTrigger value="withdraw">Withdraw</TabsTrigger>
          </TabsList>

          {/* ── DEPOSIT ── */}
          <TabsContent value="deposit" className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Deposit Naira via Paystack. Funds appear instantly as tNGN.
            </p>
            <div className="space-y-2 relative">
              <Label>Amount (₦)</Label>
              <Input
                type="number"
                placeholder="Min ₦500"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                min={500}
              />
            </div>

            {dp && (
              <div className="text-xs text-muted-foreground space-y-1 bg-muted/30 rounded p-3">
                <div className="flex justify-between">
                  <span>Paystack fee</span>
                  <span>₦{dp.paystackFee}</span>
                </div>
                <div className="flex justify-between">
                  <span>Total billed</span>
                  <span>₦{dp.totalCharge}</span>
                </div>
                <div className="flex justify-between font-semibold text-foreground">
                  <span>You receive</span>
                  <span>{dp.tNGN} tNGN</span>
                </div>
              </div>
            )}

            <Button
              onClick={handleDeposit}
              disabled={isLoading}
              className="w-full bg-foreground text-background hover:bg-foreground/90 font-semibold"
            >
              {isLoading ? 'Processing...' : 'Deposit Naira'}
            </Button>
          </TabsContent>

          {/* ── WITHDRAW ── */}
          <TabsContent value="withdraw" className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              Withdraw to any Nigerian bank account. Arrives in 1-2 hours.
            </p>
            <div className="space-y-2">
              <Label>Amount (tNGN)</Label>
              <Input
                type="number"
                placeholder="Min 1,000 tNGN"
                value={withdrawAmount}
                onChange={(e) => setWithdrawAmount(e.target.value)}
                min={1000}
                max={balance}
              />
            </div>
            <div className="space-y-2">
              <Label>Bank Code</Label>
              <Input
                type="text"
                placeholder="e.g. 058 (GTBank)"
                value={bankCode}
                onChange={(e) => setBankCode(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Account Number</Label>
              <Input
                type="text"
                placeholder="10-digit NUBAN"
                maxLength={10}
                value={accountNumber}
                onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
              />
            </div>

            {wp && (
              <div className="text-xs text-muted-foreground space-y-1 bg-muted/30 rounded p-3">
                <div className="flex justify-between">
                  <span>Fees (spread + ₦100)</span>
                  <span>{wp.fees} tNGN</span>
                </div>
                <div className="flex justify-between font-semibold text-foreground">
                  <span>You receive</span>
                  <span>₦{wp.naira}</span>
                </div>
                {Number(withdrawAmount) >= 500000 && (
                  <p className="text-amber-500 pt-1">
                    ⚠️ Large withdrawals require a security review (up to 24 hours).
                  </p>
                )}
              </div>
            )}

            <Button
              onClick={handleWithdraw}
              disabled={isLoading || !withdrawAmount || !bankCode || !accountNumber}
              className="w-full"
              variant="secondary"
            >
              {isLoading ? 'Processing...' : 'Withdraw to Bank'}
            </Button>
          </TabsContent>
        </Tabs>

        {/* RainbowKit fallback — crypto-natives only */}
        <div className="pt-2 border-t text-center">
          <p className="text-xs text-muted-foreground">
            Using an external wallet?{' '}
            <button
              className="underline underline-offset-2 hover:text-foreground transition-colors"
              onClick={() => {
                /* RainbowKit connect — only shown here, never in onboarding */
                toast({ title: 'External wallet', description: 'RainbowKit connect goes here (Phase 3).' });
              }}
            >
              Connect wallet
            </button>
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
