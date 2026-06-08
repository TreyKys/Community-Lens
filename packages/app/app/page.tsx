'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { TrendingUp, Zap, Shield, LogIn, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { AuthModal } from '@/components/AuthModal';

// We persist the "has seen landing" flag so returning visitors skip straight
// to /markets. Signed-in users always skip. First-time anonymous visitors see
// the pitch once, then we set the flag and route them through normally.
const LANDING_SEEN_KEY = 'opinions_landing_seen_v1';

export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      const seen = typeof window !== 'undefined' && localStorage.getItem(LANDING_SEEN_KEY) === '1';
      if (session || seen) {
        router.replace('/markets');
        return;
      }
      setChecking(false);
    })();
    return () => { cancelled = true; };
  }, [router]);

  const markSeenAndGo = () => {
    try { localStorage.setItem(LANDING_SEEN_KEY, '1'); } catch {}
  };

  if (checking) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-65px)]">
        <Loader2 className="w-6 h-6 animate-spin text-emerald-400" />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] p-8 text-center overflow-hidden">
      {/* Living gradient — emerald + black, slow drift */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-emerald-500/15 blur-[140px] animate-pulse-slow" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] rounded-full bg-emerald-700/10 blur-[120px] animate-float-slow" />
        <div className="absolute top-1/2 left-0 w-[450px] h-[450px] rounded-full bg-emerald-400/8 blur-[140px] animate-pulse-slow" />
      </div>

      <main className="flex flex-col gap-6 max-w-3xl items-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-xs uppercase tracking-[0.25em] text-emerald-400 font-semibold"
        >
          Event-prediction market · Made in Naija
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-4 py-1.5 text-xs font-medium text-emerald-300"
        >
          🎁 Launch offer — the first 500 members get ₦500 in free credits. Ends Friday.
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-6xl md:text-7xl font-extrabold tracking-tight bg-gradient-to-br from-foreground via-foreground to-foreground/60 bg-clip-text text-transparent"
        >
          Opinions.ng
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="text-2xl md:text-3xl text-muted-foreground font-light"
        >
          Smart money doesn&apos;t guess. It <span className="text-foreground font-medium">takes positions.</span>
        </motion.p>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="text-base md:text-lg text-muted-foreground/80 max-w-xl"
        >
          Predict football, pop culture, politics, and the economy. Instant settlement.
          Cryptographically sealed. Built for Nigeria.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="flex gap-3 justify-center mt-6 flex-wrap"
        >
          <AuthModal trigger={
            <Button size="lg" className="text-lg px-8 py-6 h-auto gap-2 bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/30">
              <LogIn className="w-5 h-5" />
              Sign Up / Sign In
            </Button>
          } />
          <Link href="/markets" onClick={markSeenAndGo}>
            <Button size="lg" variant="outline" className="text-lg px-8 py-6 h-auto gap-2">
              <Zap className="w-5 h-5" />
              Explore Markets
            </Button>
          </Link>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.6 }}
          className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-16 w-full max-w-2xl"
        >
          {[
            { icon: Zap, label: 'Instant Settlement', desc: '50 ms trade entry. No MetaMask.' },
            { icon: Shield, label: 'Cryptographic Proof', desc: 'Every position sealed on Polygon.' },
            { icon: TrendingUp, label: 'Real Markets', desc: 'EPL, LaLiga, eSports, elections.' },
          ].map(({ icon: Icon, label, desc }) => (
            <div key={label} className="p-4 rounded-xl border border-emerald-500/15 bg-card/30 backdrop-blur text-left">
              <Icon className="w-4 h-4 text-emerald-400 mb-2" />
              <div className="text-sm font-semibold">{label}</div>
              <div className="text-xs text-muted-foreground mt-1">{desc}</div>
            </div>
          ))}
        </motion.div>
      </main>

      <footer className="mt-16 text-center text-xs text-muted-foreground pt-8 relative z-10">
        <p>Opinions.ng © {new Date().getFullYear()} · A NeuroDev Labs product. Polygon-sealed prediction ledger.</p>
      </footer>
    </div>
  );
}
