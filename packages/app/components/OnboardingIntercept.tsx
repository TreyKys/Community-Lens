'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

export function OnboardingIntercept() {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [firstName, setFirstName] = useState('');
  const [dob, setDob] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [session, setSession] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function checkUserRegistration() {
      if (!session?.user?.id) return;

      try {
        const { data, error } = await supabase
          .from('users')
          .select('first_name')
          .eq('id', session.user.id)
          .single();

        if (error || !data?.first_name) {
          setIsOpen(true);
        }
      } catch (error) {
        console.error("Error checking user registration:", error);
      }
    }

    checkUserRegistration();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !dob || !session?.user?.id) return;

    setIsSubmitting(true);
    try {
      const { error } = await supabase
        .from('users')
        .update({
          first_name: firstName,
          dob,
        })
        .eq('id', session.user.id);

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
