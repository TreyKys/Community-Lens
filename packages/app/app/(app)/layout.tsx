import { Suspense } from 'react';
import { Sidebar } from "@/components/Sidebar";
import { ReferralBonusToast } from "@/components/ReferralBonusToast";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
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
  );
}
