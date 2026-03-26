'use client';

import { usePrivy } from '@privy-io/react-auth';
import { useAccount } from 'wagmi';
import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

export function OnboardingIntercept() {
  const { authenticated, user } = usePrivy();
  const { address } = useAccount();
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [dob, setDob] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    async function checkUserRegistration() {
      // Need both authenticated and a wallet address
      if (!authenticated || !user || !address) return;

      try {
        const walletAddress = address.toLowerCase();

        // Check if user already exists in our database
        const { data, error } = await supabase
          .from('users')
          .select('first_name')
          .eq('walletAddress', walletAddress)
          .single();

        // If user doesn't exist or doesn't have a first name, show the form
        if (error || !data?.first_name) {
          setIsOpen(true);
        }
      } catch (error) {
        console.error("Error checking user registration:", error);
      }
    }

    checkUserRegistration();
  }, [authenticated, user, address]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !dob || !address) return;

    setIsSubmitting(true);
    try {
      const walletAddress = address.toLowerCase();
      const phone = user?.phone?.number || null;

      const { error } = await supabase
        .from('users')
        .upsert({
          walletAddress,
          first_name: firstName,
          dob,
          phone,
          bonus_balance: 0 // Initialize bonus balance
        }, { onConflict: 'walletAddress' });

      if (error) throw error;

      toast({
        title: "Welcome to TruthMarket! 🎉",
        description: "Your profile has been set up successfully.",
      });

      setIsOpen(false);
    } catch (error) {
      console.error("Failed to save user info:", error);
      toast({
        title: "Setup Failed",
        description: "We couldn't save your profile. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogContent className="sm:max-w-[425px]" onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Complete Your Profile</DialogTitle>
          <DialogDescription>
            Almost done! We just need a few details to finalize your account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 pt-4">
          <div className="space-y-2">
            <Label htmlFor="firstName">First Name</Label>
            <Input
              id="firstName"
              placeholder="e.g. John"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="dob">Date of Birth</Label>
            <Input
              id="dob"
              type="date"
              value={dob}
              onChange={(e) => setDob(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Start Trading"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
