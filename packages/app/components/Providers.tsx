'use client';

import * as React from 'react';
import { polygonAmoy } from 'wagmi/chains';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, fallback, cookieStorage, createStorage } from 'wagmi';
import { WagmiProvider } from 'wagmi';
import { getDefaultConfig, RainbowKitProvider, darkTheme } from '@rainbow-me/rainbowkit';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import '@rainbow-me/rainbowkit/styles.css';

const config = getDefaultConfig({
  appName: 'TruthMarket',
  projectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_ID || "1234567890abcdef1234567890abcdef",
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
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          <RainbowKitProvider
            theme={darkTheme({
              accentColor: '#ffffff',
              accentColorForeground: 'black',
              borderRadius: 'medium',
            })}
          >
            {children}
          </RainbowKitProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </NextThemesProvider>
  );
}
