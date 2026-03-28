'use client';

import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export function AuthModal() {
  const [isOpen, setIsOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState<'request' | 'verify'>('request');
  const [method, setMethod] = useState<'phone' | 'email'>('phone');
  const [isLoading, setIsLoading] = useState(false);
  const { toast } = useToast();

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (method === 'phone') {
        // Need a robust standardizing format but basic length check for now
        if (phone.length < 10) throw new Error("Invalid phone number");

        const { error } = await supabase.auth.signInWithOtp({
          phone: phone,
        });
        if (error) throw error;
      } else {
        if (!email.includes('@')) throw new Error("Invalid email");

        const { error } = await supabase.auth.signInWithOtp({
          email: email,
        });
        if (error) throw error;
      }

      setStep('verify');
      toast({
        title: "Code Sent",
        description: `We've sent a code to your ${method}.`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to send code.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      // @ts-ignore
      const { data: { session }, error } = await supabase.auth.verifyOtp({
        ...(method === 'phone' ? { phone } : { email }),
        token: otp,
        type: method === 'phone' ? 'sms' : 'email',
      });

      if (error) throw error;

      if (session?.user) {
        // We call our internal backend endpoint to verify or create user and fetch/create KMS key.
        // For right now, it will ensure they have a record in `users` table.
        const res = await fetch('/api/auth/verify-otp', {
           method: 'POST',
           headers: {
             'Content-Type': 'application/json',
             'Authorization': `Bearer ${session.access_token}`
           },
           body: JSON.stringify({
             phone: method === 'phone' ? phone : null,
             email: method === 'email' ? email : null
           })
        });

        if (!res.ok) {
           console.error("Backend sync failed");
        }
      }

      setIsOpen(false);
      setStep('request');
      setOtp('');
      window.location.reload(); // Refresh session state quickly

    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Invalid code.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const resetForm = () => {
     setStep('request');
     setOtp('');
     setIsLoading(false);
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
        if (!open) resetForm();
        setIsOpen(open);
    }}>
      <DialogTrigger asChild>
        <Button size="lg" className="font-semibold px-6">
          Sign In / Sign Up
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{step === 'request' ? 'Welcome to TruthMarket' : 'Enter Code'}</DialogTitle>
          <DialogDescription>
            {step === 'request'
              ? 'Log in or create an account to start predicting.'
              : `Enter the code sent to ${method === 'phone' ? phone : email}`}
          </DialogDescription>
        </DialogHeader>

        {step === 'request' ? (
          <Tabs value={method} onValueChange={(v) => setMethod(v as 'phone' | 'email')} className="w-full">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="phone">Phone</TabsTrigger>
              <TabsTrigger value="email">Email</TabsTrigger>
            </TabsList>

            <TabsContent value="phone">
               <form onSubmit={handleRequestOtp} className="space-y-4 pt-4">
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone Number</Label>
                    <Input
                      id="phone"
                      type="tel"
                      placeholder="+234..."
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? "Sending..." : "Continue with Phone"}
                  </Button>
               </form>
            </TabsContent>

            <TabsContent value="email">
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
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={isLoading}>
                    {isLoading ? "Sending..." : "Continue with Email"}
                  </Button>
               </form>
            </TabsContent>
          </Tabs>
        ) : (
          <form onSubmit={handleVerifyOtp} className="space-y-4 pt-4">
            <div className="space-y-2">
              <Label htmlFor="otp">6-Digit Code</Label>
              <Input
                id="otp"
                type="text"
                placeholder="000000"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                required
                className="text-center text-2xl tracking-widest h-14"
              />
            </div>
            <Button type="submit" className="w-full" disabled={isLoading || otp.length < 6}>
              {isLoading ? "Verifying..." : "Verify Code"}
            </Button>
            <div className="text-center">
              <Button type="button" variant="link" size="sm" onClick={resetForm} className="text-muted-foreground">
                Wrong {method}? Go back
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
