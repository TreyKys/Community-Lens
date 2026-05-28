'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function AuthModal({ variant = 'default' }: { variant?: 'default' | 'icon' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (!email.includes('@')) throw new Error('Invalid email address');

      const normalizedEmail = email.trim().toLowerCase();

      if (process.env.NEXT_PUBLIC_BYPASS_OTP === 'true' && normalizedEmail.includes('@odds.ng')) {
        // Authenticate the bot server-side to avoid exposing the password
        const bypassRes = await fetch('/api/auth/bot-bypass', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: normalizedEmail }),
        });

        if (!bypassRes.ok) {
          const errData = await bypassRes.json();
          throw new Error(errData.error || 'Bot bypass failed');
        }

        const { session } = await bypassRes.json();

        if (session) {
          // Set the session client-side so middleware and app recognizes it
          const { error: setSessionError } = await supabase.auth.setSession(session);

          if (setSessionError) throw setSessionError;

          // Ensure successful bot auth immediately pushes to dashboard and short-circuits form state
          window.location.href = '/dashboard';
          return;
        }
      }

      // signInWithOtp with shouldCreateUser:true sends a 6-digit code
      // (NOT a magic link) as long as "Confirm email" is OFF in Supabase dashboard.
      // Dashboard path: Authentication → Providers → Email → disable "Confirm email"
      const { error } = await supabase.auth.signInWithOtp({
        email: normalizedEmail,
        options: {
          shouldCreateUser: true,
        },
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

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      const { data: { session }, error } = await supabase.auth.verifyOtp({
        email: email.trim().toLowerCase(),
        token: otp.trim(),
        type: 'email',
      });

      if (error) throw error;

      if (session?.user) {
        // Sync user record to our backend — creates the users row + derives wallet address
        const res = await fetch('/api/auth/verify-otp', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ email }),
        });

        if (!res.ok) {
          console.error('Backend sync failed — user will still be logged in');
        }
      }

      setIsOpen(false);
      resetForm();
      window.location.reload();
    } catch (error: any) {
      toast({
        title: 'Invalid Code',
        description: error.message || 'The code is incorrect or expired. Try again.',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
    setStep('request');
    setOtp('');
    setEmail('');
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
        {variant === 'icon' ? (
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
            {step === 'request' ? 'Welcome to Odds.ng' : 'Enter Your Code'}
          </DialogTitle>
          <DialogDescription>
            {step === 'request'
              ? 'Log in or create an account to start predicting.'
              : `We sent a 6-digit code to ${email}`}
          </DialogDescription>
        </DialogHeader>

        {step === 'request' ? (
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
            <Button type="submit" className="w-full" disabled={isLoading}>
              {isLoading ? 'Sending...' : 'Continue with Email'}
            </Button>
            <p className="text-xs text-center text-muted-foreground">
              Phone login coming soon via SMS
            </p>
          </form>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4 pt-4">
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
              {isLoading ? 'Verifying...' : 'Verify Code'}
            </Button>
            <div className="text-center">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={resetForm}
                className="text-muted-foreground"
              >
                Wrong email? Go back
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
