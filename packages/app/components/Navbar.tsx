'use client';

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId } from 'wagmi';
import { WalletModal } from '@/components/WalletModal';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Mail, Phone, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { FcGoogle } from "react-icons/fc";

function CustomGatewayModal() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button size="lg" className="font-semibold px-6">Sign In</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle className="text-xl text-center">Welcome to TruthMarket</DialogTitle>
          <DialogDescription className="text-center">
            Sign up or sign in to start trading predictions.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 mt-4">
          <Button variant="outline" className="w-full justify-start text-muted-foreground relative">
            <FcGoogle className="w-5 h-5 absolute left-4" />
            <span className="flex-1 text-center font-normal text-foreground">Continue with Google</span>
          </Button>

          <Button variant="outline" className="w-full justify-start text-muted-foreground relative">
            <Mail className="w-4 h-4 absolute left-4" />
            <span className="flex-1 text-center font-normal text-foreground">Continue with Email</span>
          </Button>

          <Button variant="outline" className="w-full justify-start text-muted-foreground relative">
            <Phone className="w-4 h-4 absolute left-4" />
            <span className="flex-1 text-center font-normal text-foreground">Continue with Phone</span>
          </Button>
        </div>

        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <Separator className="w-full" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-background px-2 text-xs text-muted-foreground">or</span>
          </div>
        </div>

        <div className="flex flex-col items-center gap-2">
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
                const connected =
                  ready &&
                  account &&
                  chain;

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
                    className="w-full"
                  >
                    {(() => {
                      if (!connected) {
                        return (
                          <div className="flex items-center gap-2 w-full">
                            <Button
                                onClick={(e) => {
                                    e.preventDefault();
                                    setIsOpen(false);
                                    openConnectModal();
                                }}
                                className="flex-1 font-semibold"
                                variant="secondary"
                            >
                                Connect Web3 Wallet
                            </Button>

                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Button variant="ghost" size="icon" className="rounded-full w-8 h-8 text-muted-foreground hover:text-primary">
                                    <Info className="h-4 w-4" />
                                    <span className="sr-only">Wallet Info</span>
                                  </Button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-[250px] p-4 text-sm leading-relaxed">
                                  <p className="font-semibold mb-1">What is a Web3 Wallet?</p>
                                  A digital wallet (like MetaMask or Coinbase Wallet) lets you log in without passwords and take full custody of your funds. You approve transactions cryptographically.
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </div>
                        );
                      }

                      if (chain.unsupported) {
                        return (
                          <Button onClick={openChainModal} variant="destructive" className="w-full">
                            Wrong network
                          </Button>
                        );
                      }

                      return (
                        <div className="flex gap-2 w-full justify-center">
                          <Button
                            onClick={openChainModal}
                            variant="outline"
                            className="flex items-center"
                          >
                            {chain.hasIcon && (
                              <div
                                style={{
                                  background: chain.iconBackground,
                                  width: 12,
                                  height: 12,
                                  borderRadius: 999,
                                  overflow: 'hidden',
                                  marginRight: 4,
                                }}
                              >
                                {chain.iconUrl && (
                                  <img
                                    alt={chain.name ?? 'Chain icon'}
                                    src={chain.iconUrl}
                                    style={{ width: 12, height: 12 }}
                                  />
                                )}
                              </div>
                            )}
                            {chain.name}
                          </Button>

                          <Button onClick={openAccountModal} variant="outline">
                            {account.displayName}
                            {account.displayBalance
                              ? ` (${account.displayBalance})`
                              : ''}
                          </Button>
                        </div>
                      );
                    })()}
                  </div>
                );
              }}
            </ConnectButton.Custom>
        </div>

      </DialogContent>
    </Dialog>
  );
}

export function Navbar() {
  const chainId = useChainId();
  const { address, isConnected } = useAccount();

  // Polygon Amoy is 80002
  const showWallet = chainId === 80002 && !!address;

  return (
    <nav className="flex items-center justify-between p-4 border-b">
      <div className="text-xl font-bold">
        <span>TruthMarket</span>
      </div>
      <div className="flex items-center gap-4">
        {showWallet && <WalletModal />}

        {isConnected ? (
            <ConnectButton />
        ) : (
            <CustomGatewayModal />
        )}
      </div>
    </nav>
  );
}
