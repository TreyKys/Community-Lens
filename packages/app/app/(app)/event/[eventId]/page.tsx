import { MarketList } from "@/components/MarketList";
import { EventChart } from "@/components/EventChart";
import { Suspense } from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function EventPage({ params }: { params: { eventId: string } }) {
  const eventId = BigInt(params.eventId);

  return (
    <div className="relative min-h-screen">
      {/* Black to Blue Mesh Background */}
      <div className="fixed inset-0 z-0 pointer-events-none opacity-30">
        <div className="absolute top-0 left-0 w-full h-full bg-[radial-gradient(circle_at_50%_0%,rgba(14,165,233,0.15),transparent_50%)]"></div>
        <div className="absolute top-1/4 right-0 w-[500px] h-[500px] rounded-full bg-blue-500/10 blur-[120px] mix-blend-screen"></div>
        <div className="absolute bottom-0 left-1/4 w-[600px] h-[600px] rounded-full bg-indigo-500/10 blur-[150px] mix-blend-screen"></div>
      </div>

      <div className="relative z-10 p-4 md:p-8 space-y-6 max-w-2xl mx-auto pb-24 md:pb-8">
        <div className="flex items-center gap-4">
          <Link href="/">
              <Button variant="ghost" size="icon">
                  <ArrowLeft className="w-4 h-4" />
              </Button>
          </Link>
          <h1 className="text-2xl font-bold tracking-tight">Event Details</h1>
        </div>

        <div className="space-y-8">
            <div className="w-full">
              <EventChart marketId={params.eventId} />
            </div>

            <div>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Main Event</h2>
                <Suspense fallback={<div className="p-8 text-center text-muted-foreground border rounded-lg">Loading main market...</div>}>
                  {/* Specific view: Only show the exact parent market */}
                  <MarketList filterExactMarketId={eventId} />
                </Suspense>
            </div>

            <div>
                <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">Sub-Markets</h2>
                <Suspense fallback={<div className="p-8 text-center text-muted-foreground border rounded-lg">Loading sub-markets...</div>}>
                  {/* Specific view: Only show the children of this parent market */}
                  <MarketList filterChildrenOfParentId={eventId} />
                </Suspense>
            </div>
        </div>
      </div>
    </div>
  );
}
