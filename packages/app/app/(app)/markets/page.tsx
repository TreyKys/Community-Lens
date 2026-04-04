import { MarketList } from "@/components/MarketList";
import { JackpotBanner } from "@/components/JackpotBanner";
import { Suspense } from "react";

export default function MarketsPage() {
  return (
    <div className="flex flex-col min-h-screen pb-20 md:pb-0">
      <Suspense fallback={null}>
        <JackpotBanner />
      </Suspense>
      <div className="flex-1 p-4 md:p-6">
        <Suspense fallback={
          <div className="space-y-3">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-36 bg-muted/30 rounded-xl animate-pulse" />
            ))}
          </div>
        }>
          <MarketList />
        </Suspense>
      </div>
    </div>
  );
}
