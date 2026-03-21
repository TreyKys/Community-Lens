'use client';

import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { formatUnits } from 'viem';
import { useState, useEffect } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI, SAFE_AMOY_GAS } from '@/lib/constants';
import { useToast } from '@/hooks/use-toast';

const BOT_WALLET_ADDRESS = "0xA1622ad08E558AE506b18d4028A6F613fd90F916".toLowerCase();

export default function AdminPage() {
  const { address } = useAccount();
  const { toast } = useToast();
  const [isMounted, setIsMounted] = useState(false);
  // const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS; // Auth check disabled for debugging

  // Create Market State
  const [category, setCategory] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [deadline, setDeadline] = useState('');
  const [presets, setPresets] = useState({
      matchWinner: false,
      btts: false,
      overUnder25: false,
  });

  // Resolve Market State
  const [resolveMarketId, setResolveMarketId] = useState('');
  const [winningOptionIndex, setWinningOptionIndex] = useState('');
  const [isResolveModalOpen, setIsResolveModalOpen] = useState(false);

  // Read Markets State
  const { data: nextId } = useReadContract({
    address: TRUTH_MARKET_ADDRESS as `0x${string}`,
    abi: TRUTH_MARKET_ABI,
    functionName: 'nextMarketId',
  });

  const count = nextId ? Number(nextId) : 0;
  const marketIds = Array.from({ length: count }, (_, i) => BigInt(count - 1 - i));

  const { data: marketsData, isLoading: isMarketsLoading } = useReadContracts({
    contracts: marketIds.map((id) => ({
      address: TRUTH_MARKET_ADDRESS as `0x${string}`,
      abi: TRUTH_MARKET_ABI,
      functionName: 'markets',
      args: [id],
    })),
  });

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

  // Contract Write Hook for Create Batch
  const {
    writeContract: createMarketBatch,
    data: createBatchHash,
    isPending: isCreateBatchPending
  } = useWriteContract();

  const {
      isLoading: isCreateBatchConfirming,
      isSuccess: isCreateBatchSuccess
  } = useWaitForTransactionReceipt({ hash: createBatchHash });

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
    if (isCreateSuccess || isCreateBatchSuccess) {
        toast({
            title: isCreateBatchSuccess ? "Markets Created!" : "Market Created!",
            description: "The new market(s) have been deployed.",
        });
        setQuestion('');
        setOptions('');
        setDeadline('');
        setPresets({
            matchWinner: false,
            btts: false,
            overUnder25: false,
        });
    }
  }, [isCreateSuccess, isCreateBatchSuccess, toast]);

  // Handle Resolve Success
  useEffect(() => {
    if (isResolveSuccess) {
        toast({
            title: "Market Resolved!",
            description: `Market ${resolveMarketId} has been resolved.`,
        });
        setResolveMarketId('');
        setWinningOptionIndex('');
        setIsResolveModalOpen(false);
    }
  }, [isResolveSuccess, resolveMarketId, toast]);

  if (!isMounted) return null;

  // AUTH CHECK REMOVED
  /*
  const isAuthorized = address && adminAddress && address.toLowerCase() === adminAddress.toLowerCase();
  if (!isAuthorized) { ... }
  */

  const handleCreateSubmit = () => {
     if (!question || !deadline) {
         toast({
             title: "Error",
             description: "Please fill in the Event/Question and Deadline fields",
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

     let formattedQuestion = question;
     if (category && category !== 'Sports') {
        const tag = `[${category.toUpperCase()}]`;
        if (!formattedQuestion.includes(tag)) {
            formattedQuestion = `${tag} ${formattedQuestion}`;
        }
     }

     // Check if we are using presets or custom options
     const usePresets = presets.matchWinner || presets.btts || presets.overUnder25;

     if (usePresets) {
         const questions: string[] = [];
         const optionsArr: string[][] = [];
         const durations: bigint[] = [];

         if (presets.matchWinner) {
             questions.push(`${formattedQuestion} (Match Winner)`);
             optionsArr.push(["Home Win", "Away Win", "Draw"]);
             durations.push(BigInt(durationSeconds));
         }
         if (presets.btts) {
             questions.push(`${formattedQuestion} (BTTS)`);
             optionsArr.push(["Yes", "No"]);
             durations.push(BigInt(durationSeconds));
         }
         if (presets.overUnder25) {
             questions.push(`${formattedQuestion} (Over/Under 2.5 Goals)`);
             optionsArr.push(["Over 2.5", "Under 2.5"]);
             durations.push(BigInt(durationSeconds));
         }

         const parentIds = Array(questions.length).fill(BigInt(0));

         createMarketBatch({
             address: TRUTH_MARKET_ADDRESS as `0x${string}`,
             abi: TRUTH_MARKET_ABI,
             functionName: 'createMarketBatch',
             args: [questions, optionsArr, durations, parentIds],
             ...SAFE_AMOY_GAS,
         });
     } else {
         const optionsArray = options.split(',').map(o => o.trim()).filter(o => o.length > 0);
         if (optionsArray.length < 2) {
             toast({
                 title: "Error",
                 description: "At least 2 options are required for a Custom Market",
                 variant: "destructive"
             });
             return;
         }

         createMarket({
             address: TRUTH_MARKET_ADDRESS as `0x${string}`,
             abi: TRUTH_MARKET_ABI,
             functionName: 'createMarket',
             args: [formattedQuestion, optionsArray, BigInt(durationSeconds), BigInt(0)],
             ...SAFE_AMOY_GAS,
         });
     }
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
          ...SAFE_AMOY_GAS,
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
            <label className="text-sm font-medium">Category</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger>
                <SelectValue placeholder="Select a category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Sports">Sports</SelectItem>
                <SelectItem value="Politics">Politics</SelectItem>
                <SelectItem value="Crypto">Crypto</SelectItem>
                <SelectItem value="Custom">Custom</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Question / Event</label>
            <Input
              placeholder="Arsenal vs Chelsea"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
          </div>

          <div className="space-y-4 border rounded-md p-4">
            <label className="text-sm font-medium">Market Presets (Select one or more)</label>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="preset-match-winner"
                  checked={presets.matchWinner}
                  onCheckedChange={(checked) => setPresets({...presets, matchWinner: checked === true})}
                />
                <label htmlFor="preset-match-winner" className="text-sm">Match Winner (Home/Draw/Away)</label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="preset-btts"
                  checked={presets.btts}
                  onCheckedChange={(checked) => setPresets({...presets, btts: checked === true})}
                />
                <label htmlFor="preset-btts" className="text-sm">Both Teams to Score (BTTS) (Yes/No)</label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="preset-ou25"
                  checked={presets.overUnder25}
                  onCheckedChange={(checked) => setPresets({...presets, overUnder25: checked === true})}
                />
                <label htmlFor="preset-ou25" className="text-sm">Over/Under 2.5 Goals (Over/Under)</label>
              </div>
            </div>

            <div className="pt-4 border-t mt-4">
              <label className="text-sm font-medium block mb-2">Or Custom Options (comma-separated, leave presets unchecked)</label>
              <Input
                placeholder="Candidate A, Candidate B"
                value={options}
                onChange={(e) => setOptions(e.target.value)}
                disabled={presets.matchWinner || presets.btts || presets.overUnder25}
              />
            </div>
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
            disabled={isCreatePending || isCreateConfirming || isCreateBatchPending || isCreateBatchConfirming}
          >
            {isCreatePending || isCreateConfirming || isCreateBatchPending || isCreateBatchConfirming ? 'Creating...' : 'Create Market'}
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

      {/* ADMIN MASTER TABLE */}
      <Card>
        <CardHeader>
          <CardTitle>Active & Recent Markets</CardTitle>
        </CardHeader>
        <CardContent>
          {isMarketsLoading ? (
            <div className="text-center p-4">Loading markets...</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Event / Question</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Pool Vol (USDC)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(marketsData || []).map((result, index) => {
                  if (result.status !== 'success' || !result.result) return null;
                  const marketId = marketIds[index];
                  const [question, resolved, , voided, totalPool, bettingEndsAt, creator] = result.result as unknown as [string, boolean, bigint, boolean, bigint, bigint, string];

                  const isExpired = Number(bettingEndsAt) * 1000 < Date.now();
                  let status = "Active";
                  if (voided) status = "Voided";
                  else if (resolved) status = "Closed";
                  else if (isExpired) status = "Resolving";

                  let categoryLabel = "Custom";
                  if (question.includes('[SPORTS]') || question.match(/\[[A-Z0-9]{2,}\]/)) categoryLabel = "Sports";
                  if (question.includes('[POLITICS]') || question.includes('[US]') || question.includes('[NG]')) categoryLabel = "Politics";
                  if (question.includes('[CRYPTO]')) categoryLabel = "Crypto";

                  const source = creator.toLowerCase() === BOT_WALLET_ADDRESS ? "Bot" : "Admin";

                  return (
                    <TableRow key={marketId.toString()}>
                      <TableCell className="font-mono">{marketId.toString()}</TableCell>
                      <TableCell className="max-w-xs truncate" title={question}>{question}</TableCell>
                      <TableCell>{categoryLabel}</TableCell>
                      <TableCell>{formatUnits(totalPool, 18)}</TableCell>
                      <TableCell>
                        <Badge variant={status === "Active" ? "default" : status === "Resolving" ? "secondary" : status === "Voided" ? "destructive" : "outline"}>
                          {status}
                        </Badge>
                      </TableCell>
                      <TableCell>
                         <Badge variant={source === "Bot" ? "outline" : "default"}>{source}</Badge>
                      </TableCell>
                      <TableCell>
                        {source === "Admin" && status === "Resolving" && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                                setResolveMarketId(marketId.toString());
                                setIsResolveModalOpen(true);
                            }}
                          >
                            Resolve
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* RESOLVE MARKET MODAL */}
      <Dialog open={isResolveModalOpen} onOpenChange={setIsResolveModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve Market #{resolveMarketId}</DialogTitle>
            <DialogDescription>
              Select the winning option index to resolve the market and distribute payouts. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsResolveModalOpen(false)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleResolveSubmit}
              disabled={isResolvePending || isResolveConfirming}
            >
              {isResolvePending || isResolveConfirming ? 'Resolving...' : 'Confirm Resolution'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
