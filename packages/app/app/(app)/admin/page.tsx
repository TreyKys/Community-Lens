'use client';

import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from '@/lib/constants';
import { useToast } from '@/hooks/use-toast';

export default function AdminPage() {
  const { address } = useAccount();
  const { toast } = useToast();
  const [isMounted, setIsMounted] = useState(false);
  // const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS; // Auth check disabled for debugging

  // Create Market State
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [deadline, setDeadline] = useState('');

  // Resolve Market State
  const [resolveMarketId, setResolveMarketId] = useState('');
  const [winningOptionIndex, setWinningOptionIndex] = useState('');

  // Contract Write Hook for Create
  const {
    writeContract: createMarket,
    data: createHash,
    isPending: isCreatePending
  } = useWriteContract();

  const {
      isLoading: isCreateConfirming,
      isSuccess: isCreateSuccess
  } = useWaitForTransactionReceipt({ hash: createHash });

  // Contract Write Hook for Resolve
  const {
    writeContract: resolveMarket,
    data: resolveHash,
    isPending: isResolvePending
  } = useWriteContract();

  const {
      isLoading: isResolveConfirming,
      isSuccess: isResolveSuccess
  } = useWaitForTransactionReceipt({ hash: resolveHash });

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Handle Create Success
  useEffect(() => {
    if (isCreateSuccess) {
        toast({
            title: "Market Created!",
            description: "The new market has been deployed.",
        });
        setQuestion('');
        setOptions('');
        setDeadline('');
    }
  }, [isCreateSuccess, toast]);

  // Handle Resolve Success
  useEffect(() => {
    if (isResolveSuccess) {
        toast({
            title: "Market Resolved!",
            description: `Market ${resolveMarketId} has been resolved.`,
        });
        setResolveMarketId('');
        setWinningOptionIndex('');
    }
  }, [isResolveSuccess, resolveMarketId, toast]);

  if (!isMounted) return null;

  // AUTH CHECK REMOVED
  /*
  const isAuthorized = address && adminAddress && address.toLowerCase() === adminAddress.toLowerCase();
  if (!isAuthorized) { ... }
  */

  const handleCreateSubmit = () => {
     if (!question || !options || !deadline) {
         toast({
             title: "Error",
             description: "Please fill in all fields",
             variant: "destructive"
         });
         return;
     }

     const optionsArray = options.split(',').map(o => o.trim()).filter(o => o.length > 0);
     if (optionsArray.length < 2) {
         toast({
             title: "Error",
             description: "At least 2 options are required",
             variant: "destructive"
         });
         return;
     }

     const deadlineDate = new Date(deadline);
     const now = new Date();
     const durationSeconds = Math.floor((deadlineDate.getTime() - now.getTime()) / 1000);

     if (durationSeconds <= 0) {
         toast({
             title: "Error",
             description: "Deadline must be in the future",
             variant: "destructive"
         });
         return;
     }

     createMarket({
         address: TRUTH_MARKET_ADDRESS as `0x${string}`,
         abi: TRUTH_MARKET_ABI,
         functionName: 'createMarket',
         args: [question, optionsArray, BigInt(durationSeconds)],
     });
  };

  const handleResolveSubmit = () => {
      if (!resolveMarketId || !winningOptionIndex) {
          toast({
              title: "Error",
              description: "Please fill in all fields",
              variant: "destructive"
          });
          return;
      }

      resolveMarket({
          address: TRUTH_MARKET_ADDRESS as `0x${string}`,
          abi: TRUTH_MARKET_ABI,
          functionName: 'resolveMarket',
          args: [BigInt(resolveMarketId), BigInt(winningOptionIndex)],
      });
  };

  return (
    <div className="container mx-auto p-8 space-y-8">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <div className="text-sm text-muted-foreground bg-secondary px-4 py-2 rounded-md">
           Connected: <span className="font-mono text-foreground">{address || 'Not Connected'}</span>
        </div>
      </div>

      {/* CREATE MARKET FORM */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Create New Market</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Question</label>
            <Input
              placeholder="Who will win the election?"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Options (comma-separated)</label>
            <Input
              placeholder="Candidate A, Candidate B"
              value={options}
              onChange={(e) => setOptions(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Betting Deadline</label>
            <Input
              type="datetime-local"
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
          </div>

          <Button
            className="w-full"
            onClick={handleCreateSubmit}
            disabled={isCreatePending || isCreateConfirming}
          >
            {isCreatePending || isCreateConfirming ? 'Creating...' : 'Create Market'}
          </Button>
        </CardContent>
      </Card>

      {/* RESOLVE MARKET FORM */}
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>Resolve Market</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Market ID</label>
            <Input
              type="number"
              placeholder="0"
              value={resolveMarketId}
              onChange={(e) => setResolveMarketId(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Winning Option Index</label>
            <Input
              type="number"
              placeholder="0"
              value={winningOptionIndex}
              onChange={(e) => setWinningOptionIndex(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              0 = First Option, 1 = Second Option, etc.
            </p>
          </div>

          <Button
            className="w-full"
            variant="destructive"
            onClick={handleResolveSubmit}
            disabled={isResolvePending || isResolveConfirming}
          >
            {isResolvePending || isResolveConfirming ? 'Resolving...' : 'Resolve Market'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
