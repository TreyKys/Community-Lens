'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Navbar() {
  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold">
        <span>TruthMarket</span>
      </div>
      <div>
        <ConnectButton />
      </div>
    </nav>
  );
}
