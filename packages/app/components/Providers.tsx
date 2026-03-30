'use client';

import * as React from 'react';
import { polygonAmoy } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, http, fallback } from 'wagmi';
import { RainbowKitProvider, darkTheme, getDefaultConfig } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const wcId = process.env.NEXT_PUBLIC_WALLET_CONNECT_ID || "8b5f5a8b24622cd4bcdbe2a1f50b8d8a";

const config = getDefaultConfig({
  appName: 'TruthMarket',
  projectId: wcId,
  chains: [polygonAmoy],
  ssr: true,
  transports: {
    [polygonAmoy.id]: fallback([
      http('https://rpc-amoy.polygon.technology', { batch: true }),
      http(`https://polygon-amoy.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY || 'acKkFgzIHOQy_OK7cDR60'}`, { batch: true })
    ]),
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={darkTheme()}>
            {children}
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
