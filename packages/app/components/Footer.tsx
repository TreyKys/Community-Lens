'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';

export function Footer() {
  return (
    <footer className="w-full py-6 mt-12 border-t flex flex-col items-center gap-4 text-sm text-muted-foreground pb-24 md:pb-6">
      <p>© {new Date().getFullYear()} TruthMarket. All rights reserved.</p>

      {/* Hidden RainbowKit integration for crypto-natives */}
      <div className="opacity-40 hover:opacity-100 transition-opacity flex flex-col items-center gap-2">
         <ConnectButton.Custom>
          {({
            account,
            chain,
            openAccountModal,
            openChainModal,
            openConnectModal,
            mounted,
          }) => {
            const ready = mounted;
            const connected = ready && account && chain;

            return (
              <div
                {...(!ready && {
                  'aria-hidden': true,
                  'style': {
                    opacity: 0,
                    pointerEvents: 'none',
                    userSelect: 'none',
                  },
                })}
              >
                {(() => {
                  if (!connected) {
                    return (
                      <button onClick={openConnectModal} type="button" className="text-xs underline underline-offset-4">
                        Connect external wallet (Advanced)
                      </button>
                    );
                  }

                  if (chain.unsupported) {
                    return (
                      <button onClick={openChainModal} type="button" className="text-xs text-destructive">
                        Wrong network
                      </button>
                    );
                  }

                  return (
                    <button onClick={openAccountModal} type="button" className="text-xs">
                      {account.displayName} ({account.displayBalance})
                    </button>
                  );
                })()}
              </div>
            );
          }}
        </ConnectButton.Custom>
      </div>
    </footer>
  );
}
