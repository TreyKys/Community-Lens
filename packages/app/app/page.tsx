'use client';

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { TrendingUp, Zap, Shield } from 'lucide-react';

export default function Home() {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-[calc(100vh-65px)] p-8 text-center overflow-hidden">
      {/* Animated gradient mesh backdrop */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-emerald-500/10 blur-[120px] animate-pulse" />
        <div className="absolute bottom-0 right-1/4 w-[500px] h-[500px] rounded-full bg-blue-500/10 blur-[100px]" />
        <div className="absolute top-1/2 left-0 w-[400px] h-[400px] rounded-full bg-amber-500/5 blur-[120px]" />
      </div>

      <main className="flex flex-col gap-6 max-w-3xl items-center relative z-10">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-xs uppercase tracking-[0.25em] text-emerald-400 font-semibold"
        >
          Event-derivative market · Made in Naija
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="text-6xl md:text-7xl font-extrabold tracking-tight bg-gradient-to-br from-foreground via-foreground to-foreground/60 bg-clip-text text-transparent"
        >
          Odds.ng
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
          Trade the outcome of football, eSports, politics and pop culture.
          Instant settlement. Cryptographically sealed. Built for Nigeria.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
          className="flex gap-4 justify-center mt-6"
        >
          <Link href="/markets">
            <Button size="lg" className="text-lg px-8 py-6 h-auto gap-2 bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-500/20">
              <Zap className="w-5 h-5" />
              Launch App
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
            <div key={label} className="p-4 rounded-xl border border-muted/50 bg-card/30 backdrop-blur text-left">
              <Icon className="w-4 h-4 text-emerald-400 mb-2" />
              <div className="text-sm font-semibold">{label}</div>
              <div className="text-xs text-muted-foreground mt-1">{desc}</div>
            </div>
          ))}
        </motion.div>
      </main>

      <footer className="mt-16 text-center text-xs text-muted-foreground pt-8 relative z-10">
        <p>Odds.ng © {new Date().getFullYear()} · Powered by NeuroDev. Polygon-sealed bet book.</p>
      </footer>
    </div>
  );
}
