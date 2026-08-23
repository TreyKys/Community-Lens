import { MarketList } from "@/components/MarketList";
import { MarketsBackdrop } from "@/components/MarketsBackdrop";
import { MoversRail } from "@/components/MoversRail";
import { PopularMarketsScroll } from "@/components/PopularMarketsScroll";
import { CategoryTabs } from "@/components/CategoryTabs";
import { MarketsToolbar } from "@/components/MarketsToolbar";
import { Suspense } from "react";

export default function MarketsPage() {
  return (
    <div className="relative flex flex-col min-h-screen pb-20 md:pb-0">
      <Suspense fallback={null}>
        <MarketsBackdrop />
      </Suspense>
      <div className="relative z-10">
        <div className="flex-1 min-w-0 px-3 py-4 md:p-6 space-y-4 md:space-y-5">
          {/* Above Popular on purpose: "popular" is a standing ranking that
              barely changes day to day, while this is what changed TODAY.
              The thing that moved deserves the first look. */}
          <MoversRail />
          <Suspense fallback={<div className="h-32 rounded-xl shimmer" />}>
            <PopularMarketsScroll />
          </Suspense>
          <Suspense fallback={null}>
            <CategoryTabs />
          </Suspense>
          <Suspense fallback={<div className="h-10 rounded-lg shimmer" />}>
            <MarketsToolbar />
          </Suspense>
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
