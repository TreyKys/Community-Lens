import { MarketList } from "@/components/MarketList";
import { JackpotBanner } from "@/components/JackpotBanner";
import { MarketsBackdrop } from "@/components/MarketsBackdrop";
import { Suspense } from "react";

export default function MarketsPage() {
  return (
    <div className="relative flex flex-col min-h-screen pb-20 md:pb-0">
      <Suspense fallback={null}>
        <MarketsBackdrop />
      </Suspense>
      <div className="relative z-10">
        <Suspense fallback={null}>
          <JackpotBanner />
        </Suspense>
        <div className="flex-1 p-4 md:p-6">
          <Suspense fallback={
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-36 rounded-xl shimmer" />
              ))}
            </div>
          }>
            <MarketList />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
