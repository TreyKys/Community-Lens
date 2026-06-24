'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import Link from 'next/link';

export function Footer() {
  return (
    <footer className="w-full py-6 mt-12 border-t border-emerald-500/10 flex flex-col items-center gap-3 text-sm text-muted-foreground pb-24 md:pb-6">
      <div className="flex items-center gap-4 text-xs flex-wrap justify-center">
        <Link href="/trust" className="hover:text-foreground transition-colors text-emerald-400/90 hover:text-emerald-300">Trust &amp; Identity</Link>
        <span className="text-muted-foreground/40">·</span>
        <Link href="/faq" className="hover:text-foreground transition-colors">FAQ</Link>
        <span className="text-muted-foreground/40">·</span>
        <Link href="/terms" className="hover:text-foreground transition-colors">Terms</Link>
        <span className="text-muted-foreground/40">·</span>
        <Link href="/privacy" className="hover:text-foreground transition-colors">Privacy</Link>
        <span className="text-muted-foreground/40">·</span>
        <Link href="/company" className="hover:text-foreground transition-colors">Company</Link>
        <span className="text-muted-foreground/40">·</span>
        <a href="mailto:hello@opinions.ng" className="hover:text-foreground transition-colors">Contact</a>
      </div>
      <p>© {new Date().getFullYear()} Opinions.ng. All rights reserved.</p>
      <p className="text-[11px] text-muted-foreground/70">
        Opinions.ng is a product of <span className="font-medium">NeuroDev Labs Technologies</span>.
      </p>

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
