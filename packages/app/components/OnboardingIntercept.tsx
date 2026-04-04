'use client';

import { useEffect, useState, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import { Check, Loader2, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

// 50 avatars — same palette as profile page
const AVATAR_THEME: [string, string, string, string][] = [
  ['#6366f1','#8b5cf6','#c4b5fd','◈'],['#0ea5e9','#38bdf8','#7dd3fc','◎'],
  ['#f43f5e','#fb7185','#fda4af','◇'],['#10b981','#34d399','#6ee7b7','⬡'],
  ['#f59e0b','#fbbf24','#fde68a','◉'],['#8b5cf6','#a78bfa','#ddd6fe','◊'],
  ['#06b6d4','#22d3ee','#a5f3fc','⬢'],['#ef4444','#f87171','#fca5a5','◈'],
  ['#84cc16','#a3e635','#d9f99d','◎'],['#f97316','#fb923c','#fdba74','◇'],
  ['#ec4899','#f472b6','#f9a8d4','◉'],['#14b8a6','#2dd4bf','#99f6e4','◊'],
  ['#6366f1','#a78bfa','#e9d5ff','⬡'],['#0284c7','#0ea5e9','#bae6fd','⬢'],
  ['#dc2626','#ef4444','#fee2e2','◈'],['#059669','#10b981','#d1fae5','◎'],
  ['#d97706','#f59e0b','#fef3c7','◇'],['#7c3aed','#8b5cf6','#ede9fe','◉'],
  ['#0891b2','#06b6d4','#cffafe','◊'],['#db2777','#ec4899','#fce7f3','⬡'],
  ['#65a30d','#84cc16','#ecfccb','⬢'],['#ea580c','#f97316','#ffedd5','◈'],
  ['#9333ea','#a855f7','#f3e8ff','◎'],['#0369a1','#0284c7','#e0f2fe','◇'],
  ['#b91c1c','#dc2626','#fee2e2','◉'],['#047857','#059669','#d1fae5','◊'],
  ['#b45309','#d97706','#fef3c7','⬡'],['#6d28d9','#7c3aed','#ede9fe','⬢'],
  ['#0e7490','#0891b2','#cffafe','◈'],['#be185d','#db2777','#fce7f3','◎'],
  ['#4d7c0f','#65a30d','#ecfccb','◇'],['#c2410c','#ea580c','#ffedd5','◉'],
  ['#7e22ce','#9333ea','#f3e8ff','◊'],['#075985','#0369a1','#e0f2fe','⬡'],
  ['#991b1b','#b91c1c','#fee2e2','⬢'],['#065f46','#047857','#d1fae5','◈'],
  ['#92400e','#b45309','#fef3c7','◎'],['#5b21b6','#6d28d9','#ede9fe','◇'],
  ['#164e63','#0e7490','#cffafe','◉'],['#9d174d','#be185d','#fce7f3','◊'],
  ['#3f6212','#4d7c0f','#ecfccb','⬡'],['#9a3412','#c2410c','#ffedd5','⬢'],
  ['#581c87','#7e22ce','#f3e8ff','◈'],['#0c4a6e','#075985','#e0f2fe','◎'],
  ['#7f1d1d','#991b1b','#fee2e2','◇'],['#064e3b','#065f46','#d1fae5','◉'],
  ['#78350f','#92400e','#fef3c7','◊'],['#4c1d95','#5b21b6','#ede9fe','⬡'],
  ['#083344','#164e63','#cffafe','⬢'],['#831843','#9d174d','#fce7f3','◈'],
];

function AvatarSVG({ id, size = 40, selected = false }: { id: number; size?: number; selected?: boolean }) {
  const [bg1, bg2, accent, symbol] = AVATAR_THEME[id % AVATAR_THEME.length];
  const gradId = `onb_av${id}`;
  return (
    <div className={cn('rounded-xl cursor-pointer transition-all duration-200 hover:scale-110 hover:ring-2 hover:ring-primary/50', selected && 'ring-2 ring-primary scale-110')}>
      <svg width={size} height={size} viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <radialGradient id={gradId} cx="35%" cy="30%">
            <stop offset="0%" stopColor={bg1} />
            <stop offset="100%" stopColor={bg2} />
          </radialGradient>
        </defs>
        <rect width="48" height="48" rx="12" fill={`url(#${gradId})`} />
        <text x="24" y="32" textAnchor="middle" fontSize="22" fill={accent} fontFamily="monospace">{symbol}</text>
      </svg>
    </div>
  );
}

type Step = 'avatar' | 'details';

export function OnboardingIntercept() {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<Step>('avatar');
  const [selectedAvatar, setSelectedAvatar] = useState(0);
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [dob, setDob] = useState('');
  const [usernameStatus, setUsernameStatus] = useState<'idle' | 'checking' | 'available' | 'taken' | 'invalid'>('idle');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [session, setSession] = useState<any>(null);
  const usernameTimer = useRef<any>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    async function checkProfile() {
      if (!session?.user?.id) return;
      const { data } = await supabase
        .from('users')
        .select('profile_complete, avatar_id')
        .eq('id', session.user.id)
        .single();
      if (!data?.profile_complete) {
        if (data?.avatar_id !== undefined && data?.avatar_id !== null) {
          setSelectedAvatar(data.avatar_id);
        }
        setIsOpen(true);
      }
    }
    checkProfile();
  }, [session]);

  // Username validation with debounce
  useEffect(() => {
    if (!username) { setUsernameStatus('idle'); return; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) { setUsernameStatus('invalid'); return; }
    setUsernameStatus('checking');
    if (usernameTimer.current) clearTimeout(usernameTimer.current);
    usernameTimer.current = setTimeout(async () => {
      const { data } = await supabase.from('users').select('id').eq('username', username).single();
      setUsernameStatus(data ? 'taken' : 'available');
    }, 500);
  }, [username]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!firstName || !dob || !username || !session?.access_token) return;
    if (usernameStatus !== 'available') {
      toast({ title: 'Fix username first', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/user/profile', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          username: username.toLowerCase(),
          avatar_id: selectedAvatar,
          first_name: firstName,
          dob,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Setup failed');
      }

      toast({
        title: 'Welcome to TruthMarket! 🎉',
        description: `Your account is ready. Let's make some predictions, @${username}.`,
      });
      setIsOpen(false);
    } catch (error: any) {
      toast({ title: 'Setup Failed', description: error.message, variant: 'destructive' });
    } finally { setIsSubmitting(false); }
  };

  const usernameHint = {
    idle: null,
    checking: <span className="text-muted-foreground text-xs flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Checking...</span>,
    available: <span className="text-emerald-400 text-xs flex items-center gap-1"><Check className="w-3 h-3" /> Available</span>,
    taken: <span className="text-red-400 text-xs">Username taken</span>,
    invalid: <span className="text-red-400 text-xs">3-20 chars, letters/numbers/underscores only</span>,
  }[usernameStatus];

  return (
    <Dialog open={isOpen} onOpenChange={() => {}} modal>
      <DialogContent
        className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto"
        onInteractOutside={e => e.preventDefault()}
        onEscapeKeyDown={e => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="text-xl">
            {step === 'avatar' ? 'Pick your avatar' : 'Almost there'}
          </DialogTitle>
          <DialogDescription>
            {step === 'avatar'
              ? 'Choose the identity you predict under. Make it yours.'
              : 'A few last details and you\'re in.'}
          </DialogDescription>
        </DialogHeader>

        {/* Step indicator */}
        <div className="flex gap-2 my-1">
          <div className={cn('h-1 rounded-full flex-1 transition-colors', step === 'avatar' ? 'bg-primary' : 'bg-muted')} />
          <div className={cn('h-1 rounded-full flex-1 transition-colors', step === 'details' ? 'bg-primary' : 'bg-muted')} />
        </div>

        {step === 'avatar' ? (
          <div className="space-y-4">
            {/* Currently selected preview */}
            <div className="flex justify-center py-2">
              <AvatarSVG id={selectedAvatar} size={72} selected />
            </div>

            {/* Avatar grid */}
            <div className="grid grid-cols-8 gap-2 max-h-[280px] overflow-y-auto pr-1">
              {Array.from({ length: 50 }, (_, i) => (
                <div key={i} onClick={() => setSelectedAvatar(i)}>
                  <AvatarSVG id={i} size={36} selected={selectedAvatar === i} />
                </div>
              ))}
            </div>

            <Button
              className="w-full gap-2"
              onClick={() => setStep('details')}
            >
              Use this avatar <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Avatar preview small */}
            <div className="flex items-center gap-3 p-3 bg-muted/30 rounded-xl">
              <AvatarSVG id={selectedAvatar} size={36} />
              <div className="flex-1">
                <p className="text-sm font-medium">{firstName || 'Your Name'}</p>
                <p className="text-xs text-muted-foreground">@{username || 'username'}</p>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep('avatar')} className="text-xs h-7">
                Change
              </Button>
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">@</span>
                <Input
                  id="username"
                  placeholder="yourhandle"
                  value={username}
                  onChange={e => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                  className="pl-7"
                  maxLength={20}
                  required
                  autoComplete="username"
                />
              </div>
              {usernameHint && <div className="mt-1">{usernameHint}</div>}
            </div>

            <div className="space-y-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                placeholder="e.g. Trey"
                value={firstName}
                onChange={e => setFirstName(e.target.value)}
                required
                autoComplete="given-name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="dob">Date of Birth</Label>
              <Input
                id="dob"
                type="date"
                value={dob}
                onChange={e => setDob(e.target.value)}
                required
                max={new Date(Date.now() - 18 * 365.25 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
              />
              <p className="text-xs text-muted-foreground">You must be 18+ to use TruthMarket.</p>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isSubmitting || usernameStatus !== 'available' || !firstName || !dob}
            >
              {isSubmitting ? <><Loader2 className="w-4 h-4 animate-spin mr-2" /> Setting up...</> : 'Start Predicting 🎯'}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
