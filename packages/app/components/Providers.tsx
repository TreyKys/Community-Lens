'use client';

import * as React from 'react';
import '@rainbow-me/rainbowkit/styles.css';
import {
  RainbowKitProvider,
  getDefaultConfig,
} from '@rainbow-me/rainbowkit';
import { polygonAmoy } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, http } from 'wagmi';

const config = getDefaultConfig({
  appName: 'TruthMarket',
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID || '8b5f5a8b24622cd4bcdbe2a1f50b8d8a',
  chains: [polygonAmoy],
  transports: {
    [polygonAmoy.id]: http(`https://polygon-amoy.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY || 'acKkFgzIHOQy_OK7cDR60'}`),
  },
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>
          {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
