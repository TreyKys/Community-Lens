'use client';

import { useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useToast } from '@/hooks/use-toast';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';

interface AuthModalProps {
  variant?: 'default' | 'icon';
  trigger?: ReactNode;
}

type AuthMethod = 'otp' | 'password' | 'phone';

export function AuthModal({ variant = 'default', trigger }: AuthModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [phone, setPhone] = useState('');
  const [pinId, setPinId] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('otp');
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [isLoading, setIsLoading] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const { toast } = useToast();

  const applyPostAuthHooks = async (accessToken: string) => {
    try {
      fetch('/api/user/accept-terms', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      }).catch(() => {});

      const pendingRef = typeof window !== 'undefined' ? localStorage.getItem('pending_referral_code') : null;
      if (pendingRef) {
        fetch('/api/referral/redeem', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ code: pendingRef }),
        }).finally(() => {
          try { localStorage.removeItem('pending_referral_code'); } catch {}
        });
      }
    } catch {}
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) {
      toast({
        title: 'Accept the terms',
        description: 'You need to agree to our Terms & Privacy Policy to continue.',
        variant: 'destructive',
      });
      return;
    }
    setIsLoading(true);

    try {
      if (!email.includes('@')) throw new Error('Invalid email address');

      // Stash the referral code locally so the post-signup hook can redeem
      // it once the user_id is known.
      const trimmedRef = referralCode.trim().toUpperCase();
      if (trimmedRef) {
        try { localStorage.setItem('pending_referral_code', trimmedRef); } catch {}
      }

      // signInWithOtp with shouldCreateUser:true sends a 6-digit code
      // (NOT a magic link) as long as "Confirm email" is OFF in Supabase dashboard.
      // Dashboard path: Authentication → Providers → Email → disable "Confirm email"
      const { error } = await supabase.auth.signInWithOtp({
        email: email.trim().toLowerCase(),
        options: { shouldCreateUser: true },
      });

      if (error) throw error;

      setStep('verify');
      toast({
        title: 'Code Sent',
        description: `Check ${email} for your 6-digit code.`,
      });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to send code.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasswordAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) {
      toast({
        title: 'Accept the terms',
        description: 'You need to agree to our Terms & Privacy Policy to continue.',
        variant: 'destructive',
      });
      return;
    }
    setIsLoading(true);

    try {
      if (!email.includes('@')) throw new Error('Invalid email address');
      if (password.length < 8) throw new Error('Password must be at least 8 characters');

      const trimmedRef = referralCode.trim().toUpperCase();
      if (trimmedRef) {
        try { localStorage.setItem('pending_referral_code', trimmedRef); } catch {}
      }

      // Try sign in first; if user doesn't exist, create account
      const signInResult = await supabase.auth.signInWithPassword({
        email: email.trim().toLowerCase(),
        password,
      });

      if (signInResult.error) {
        // Sign-in failed (invalid creds OR user doesn't exist) — try sign-up
        const signUpResult = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
        });
        if (signUpResult.error) throw signUpResult.error;
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await applyPostAuthHooks(session.access_token);
      }

      toast({ title: 'Welcome to Opinions.ng', description: 'You are signed in.' });
      setIsOpen(false);
      window.location.href = '/markets';
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to sign in.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestPhoneOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!acceptedTerms) {
      toast({
        title: 'Accept the terms',
        description: 'You need to agree to our Terms & Privacy Policy to continue.',
        variant: 'destructive',
      });
      return;
    }
    setIsLoading(true);

    try {
      const trimmedRef = referralCode.trim().toUpperCase();
      if (trimmedRef) {
        try { localStorage.setItem('pending_referral_code', trimmedRef); } catch {}
      }

      const res = await fetch('/api/auth/phone/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not send code');

      setPinId(body.pinId);
      setStep('verify');
      toast({ title: 'Code Sent', description: `Check ${body.phone} for your 6-digit code.` });
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to send code.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyPhoneOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const res = await fetch('/api/auth/phone/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, pinId, pin: otp }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Invalid or expired code.');

      const { error: sessionError } = await supabase.auth.setSession({
        access_token: body.access_token,
        refresh_token: body.refresh_token,
      });
      if (sessionError) throw sessionError;

      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await applyPostAuthHooks(session.access_token);
      }

      toast({ title: 'Welcome to Opinions.ng', description: 'You are signed in.' });
      setIsOpen(false);
      window.location.href = '/markets';
    } catch (error: any) {
      toast({
        title: 'Verification failed',
        description: error.message || 'Invalid or expired code.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: otp,
        type: 'email',
      });
      if (error) throw error;

      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) {
        await applyPostAuthHooks(session.access_token);
      }

      toast({ title: 'Welcome to Opinions.ng', description: 'You are signed in.' });
      setIsOpen(false);
      window.location.href = '/markets';
    } catch (error: any) {
      toast({
        title: 'Verification failed',
        description: error.message || 'Invalid or expired code.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setStep('request');
    setOtp('');
    setPassword('');
    setEmail('');
    setPhone('');
    setPinId('');
    setIsLoading(false);
  };

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) resetForm();
        setIsOpen(open);
      }}
    >
      <DialogTrigger asChild>
        {trigger ? (
          trigger
        ) : variant === 'icon' ? (
          <button className="flex flex-col items-center justify-center w-full h-full gap-1 text-muted-foreground transition-colors hover:text-foreground">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
            <span className="text-[10px] font-medium">Log In</span>
          </button>
        ) : (
          <Button size="lg" className="font-semibold px-6">
            Sign In / Sign Up
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>
            {step === 'request'
              ? 'Welcome to Opinions.ng'
              : authMethod === 'password'
                ? 'Set Your Password'
                : 'Enter Your Code'}
          </DialogTitle>
          <DialogDescription>
            {step === 'request'
              ? 'Log in or create an account to start predicting.'
              : authMethod === 'otp'
                ? `We sent a 6-digit code to ${email}`
                : authMethod === 'phone'
                  ? `We sent a 6-digit code to ${phone}`
                  : 'Create a password for faster future logins'}
          </DialogDescription>
        </DialogHeader>

        {step === 'request' ? (
          <>
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 mb-4 text-xs text-emerald-300 text-center font-medium">
              🎁 Deposit ₦500+, we match it — up to ₦1,000 free. Ends Sat.
            </div>
            <div className="flex gap-2 mb-4">
              <Button
                type="button"
                variant={authMethod === 'otp' ? 'default' : 'outline'}
                className="flex-1"
                onClick={() => setAuthMethod('otp')}
              >
                Email Code
              </Button>
              <Button
                type="button"
                variant={authMethod === 'password' ? 'default' : 'outline'}
                className="flex-1"
                onClick={() => setAuthMethod('password')}
              >
                Password
              </Button>
              {process.env.NEXT_PUBLIC_ENABLE_PHONE_AUTH === 'true' && (
                <Button
                  type="button"
                  variant={authMethod === 'phone' ? 'default' : 'outline'}
                  className="flex-1"
                  onClick={() => setAuthMethod('phone')}
                >
                  Phone Code
                </Button>
              )}
            </div>

            {authMethod === 'otp' ? (
              <form onSubmit={handleRequestOtp} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address</Label>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ref" className="flex items-center justify-between">
                    <span>Referral Code <span className="text-muted-foreground text-[10px]">(optional)</span></span>
                  </Label>
                  <Input
                    id="ref"
                    type="text"
                    placeholder="e.g. ALEX25"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                    maxLength={20}
                    className="uppercase tracking-wider"
                  />
                </div>
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <Checkbox
                    checked={acceptedTerms}
                    onCheckedChange={(c) => setAcceptedTerms(c === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I&apos;m 18+ and agree to the{' '}
                    <Link href="/terms" target="_blank" className="text-emerald-400 underline">
                      Terms of Service
                    </Link>
                    {' '}and{' '}
                    <Link href="/privacy" target="_blank" className="text-emerald-400 underline">
                      Privacy Policy
                    </Link>.
                  </span>
                </label>
                <Button type="submit" className="w-full" disabled={isLoading || !acceptedTerms}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Sending code…
                    </span>
                  ) : 'Continue with Email'}
                </Button>
              </form>
            ) : authMethod === 'phone' ? (
              <form onSubmit={handleRequestPhoneOtp} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    type="tel"
                    placeholder="080XXXXXXXX"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value.replace(/[^\d+]/g, ''))}
                    required
                    autoComplete="tel"
                  />
                  <p className="text-[10px] text-muted-foreground">We&apos;ll text you a 6-digit code</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ref-phone" className="flex items-center justify-between">
                    <span>Referral Code <span className="text-muted-foreground text-[10px]">(optional)</span></span>
                  </Label>
                  <Input
                    id="ref-phone"
                    type="text"
                    placeholder="e.g. ALEX25"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                    maxLength={20}
                    className="uppercase tracking-wider"
                  />
                </div>
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <Checkbox
                    checked={acceptedTerms}
                    onCheckedChange={(c) => setAcceptedTerms(c === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I&apos;m 18+ and agree to the{' '}
                    <Link href="/terms" target="_blank" className="text-emerald-400 underline">
                      Terms of Service
                    </Link>
                    {' '}and{' '}
                    <Link href="/privacy" target="_blank" className="text-emerald-400 underline">
                      Privacy Policy
                    </Link>.
                  </span>
                </label>
                <Button type="submit" className="w-full" disabled={isLoading || !acceptedTerms || phone.length < 10}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Sending code…
                    </span>
                  ) : 'Continue with Phone'}
                </Button>
              </form>
            ) : (
              <form onSubmit={handlePasswordAuth} className="space-y-4 pt-4">
                <div className="space-y-2">
                  <Label htmlFor="email-pwd">Email Address</Label>
                  <Input
                    id="email-pwd"
                    type="email"
                    placeholder="you@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input
                    id="password"
                    type="password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                  <p className="text-[10px] text-muted-foreground">Min. 8 characters for security</p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="ref-pwd" className="flex items-center justify-between">
                    <span>Referral Code <span className="text-muted-foreground text-[10px]">(optional)</span></span>
                  </Label>
                  <Input
                    id="ref-pwd"
                    type="text"
                    placeholder="e.g. ALEX25"
                    value={referralCode}
                    onChange={(e) => setReferralCode(e.target.value.toUpperCase())}
                    maxLength={20}
                    className="uppercase tracking-wider"
                  />
                </div>
                <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer select-none">
                  <Checkbox
                    checked={acceptedTerms}
                    onCheckedChange={(c) => setAcceptedTerms(c === true)}
                    className="mt-0.5"
                  />
                  <span>
                    I&apos;m 18+ and agree to the{' '}
                    <Link href="/terms" target="_blank" className="text-emerald-400 underline">
                      Terms of Service
                    </Link>
                    {' '}and{' '}
                    <Link href="/privacy" target="_blank" className="text-emerald-400 underline">
                      Privacy Policy
                    </Link>.
                  </span>
                </label>
                <Button type="submit" className="w-full" disabled={isLoading || !acceptedTerms || password.length < 8}>
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> Signing in…
                    </span>
                  ) : 'Sign In / Sign Up'}
                </Button>
              </form>
            )}
          </>
        ) : (
          <form onSubmit={authMethod === 'phone' ? handleVerifyPhoneOtp : handleVerifyOtp} className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="otp">6-Digit Code</Label>
              <Input
                id="otp"
                type="text"
                inputMode="numeric"
                placeholder="000000"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                required
                autoComplete="one-time-code"
                className="text-center text-2xl tracking-widest h-14"
              />
            </div>
            <Button
              type="submit"
              className="w-full"
              disabled={isLoading || otp.length < 6}
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="w-4 h-4 animate-spin" /> Verifying…
                </span>
              ) : 'Verify Code'}
            </Button>
            <div className="text-center">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={resetForm}
                className="text-muted-foreground"
              >
                {authMethod === 'phone' ? 'Wrong number? Go back' : 'Wrong email? Go back'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
