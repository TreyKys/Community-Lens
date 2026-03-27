'use client';

import * as React from 'react';
import { polygonAmoy } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, fallback, cookieStorage, createStorage } from 'wagmi';
import { PrivyProvider } from '@privy-io/react-auth';
import { WagmiProvider as PrivyWagmiProvider } from '@privy-io/wagmi';
import { createConfig } from 'wagmi';

const config = createConfig({
  chains: [polygonAmoy],
  transports: {
    [polygonAmoy.id]: fallback([
      http('https://rpc-amoy.polygon.technology', { batch: true }),
      http(`https://polygon-amoy.g.alchemy.com/v2/${process.env.NEXT_PUBLIC_ALCHEMY_KEY || 'acKkFgzIHOQy_OK7cDR60'}`, { batch: true })
    ]),
  },
  ssr: true,
  storage: createStorage({
    storage: cookieStorage,
  }),
});

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  // Explicitly require the WALLET_CONNECT_ID fallback for Privy to compile WalletConnect under the hood
  // Netlify environments fail without it explicitly defined or passed as a build arg.
  const wcId = process.env.NEXT_PUBLIC_WALLET_CONNECT_ID || "1234567890abcdef1234567890abcdef";

  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID || "cm2o7h8m0092h0xix2l9f116a"}
      config={{
        loginMethods: ['sms', 'email'],
        appearance: {
          theme: 'dark',
          accentColor: '#676FFF',
          logo: '',
          walletList: ['metamask', 'rainbow', 'wallet_connect'],
        },
        defaultChain: polygonAmoy,
        supportedChains: [polygonAmoy],
        walletConnectCloudProjectId: wcId
      }}
    >
      <QueryClientProvider client={queryClient}>
        <PrivyWagmiProvider config={config}>
          {children}
        </PrivyWagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  );
}
