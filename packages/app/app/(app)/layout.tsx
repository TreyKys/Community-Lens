import { Suspense } from 'react';
import { Sidebar } from "@/components/Sidebar";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen">
      <div className="hidden md:block">
        <Suspense fallback={<div className="w-64 border-r bg-background min-h-screen p-4" />}>
          <Sidebar />
        </Suspense>
      </div>
      <div className="flex-1 bg-background pb-20 md:pb-0">
        {children}
      </div>
    </div>
  );
}
