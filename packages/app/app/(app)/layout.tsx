import { Suspense } from 'react';
import { Sidebar } from "@/components/Sidebar";
import { ReferralBonusToast } from "@/components/ReferralBonusToast";
import { SlipProvider } from "@/components/multiplier/SlipProvider";
import { MultiplierSlip } from "@/components/multiplier/MultiplierSlip";
import { AppModals } from "@/components/AppModals";
import { PushGate } from "@/components/PushGate";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // SlipProvider holds the in-progress Multiplier slip so legs picked
    // on one market survive while the user shops across others. The
    // floating MultiplierSlip launcher + drawer renders globally.
    <SlipProvider>
      <div className="flex min-h-screen">
        {/* One-shot post-signup toast: reads a stash AuthModal leaves in
            sessionStorage when a VIP referral grants the new user a
            signup bonus, then fires "🎉 ₦X bonus credit added" once. */}
        <ReferralBonusToast />
        <div className="hidden md:block">
          <Suspense fallback={<div className="w-64 border-r bg-background min-h-screen p-4" />}>
            <Sidebar />
          </Suspense>
        </div>
        <div className="flex-1 min-w-0 bg-background pb-20 md:pb-0">
          {children}
        </div>
      </div>
      <MultiplierSlip />
      {/* Return moments: at most one ever shows, and never over a flow.
          See AppModals for why Welcome Back beats What's New on a tie. */}
      <Suspense fallback={null}><AppModals /></Suspense>
      {/* Keeps an existing push subscription alive on every visit, and asks
          for permission only after someone has staked. Mounted inside the app
          shell, never on the marketing pages: a permission prompt aimed at a
          stranger is how an origin gets permanently blocked. */}
      <PushGate />
    </SlipProvider>
  );
}
