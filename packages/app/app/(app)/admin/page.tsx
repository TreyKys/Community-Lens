'use client';

import { useAccount, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatUnits } from 'viem';
import { useState, useEffect, Fragment } from 'react';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from '@/lib/constants';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';

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

  // Resolve Market State (Inline)
  const [resolvingMarketId, setResolvingMarketId] = useState<string | null>(null);
  const [winningOptionIndex, setWinningOptionIndex] = useState('');

  const [isCreating, setIsCreating] = useState(false);
  // Add Sub-Markets State
  const [isAddSubMarketsModalOpen, setIsAddSubMarketsModalOpen] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState<string | null>(null);
  const [selectedParentQuestion, setSelectedParentQuestion] = useState<string>('');
  const [selectedParentDeadline, setSelectedParentDeadline] = useState<bigint | null>(null);
  const [subMarketPresets, setSubMarketPresets] = useState({
      btts: false,
      ou05: false,
      ou15: false,
      ou25: false,
      ou35: false,
      ou45: false,
      doubleChance: false,
      drawNoBet: false,
      exactGoals: false,
      halftimeResult: false,
      bttsFirstHalf: false,
      firstTeamToScore: false,
  });
  const [customSubMarketName, setCustomSubMarketName] = useState('');
  const [customSubMarketOptions, setCustomSubMarketOptions] = useState('');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [marketsData, setMarketsData] = useState<any[]>([]);
  const [isMarketsLoading, setIsMarketsLoading] = useState(false);

  const fetchMarkets = async () => {
    setIsMarketsLoading(true);
    const { data } = await supabase.from('markets').select('*').order('created_at', { ascending: false });
    if (data) {
      setMarketsData(data);
    }
    setIsMarketsLoading(false);
  };

  useEffect(() => {
    setIsMounted(true);
    void fetchMarkets();
  }, []);

  // Contract Hooks for V2 Settlement Engine (Tab 2)
  const { writeContract, isPending: isTxPending } = useWriteContract();

  const [manualMerkleMarketId, setManualMerkleMarketId] = useState('');
  const [manualMerkleRoot, setManualMerkleRoot] = useState('');
  const [manualTotalPool, setManualTotalPool] = useState('');

  const [manualResolveMarketId, setManualResolveMarketId] = useState('');
  const [manualWinningOutcome, setManualWinningOutcome] = useState('');
  const [manualDistAmount, setManualDistAmount] = useState('');

  if (!isMounted) return null;

  // AUTH CHECK REMOVED
  /*
  const isAuthorized = address && adminAddress && address.toLowerCase() === adminAddress.toLowerCase();
  if (!isAuthorized) { ... }
  */

  const handleCreateSubmit = async () => {
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

         const parentIds = Array(questions.length).fill(0);

         setIsCreating(true);
         try {
             const res = await fetch('/api/markets/create', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ isBatch: true, questions, optionsArr, durations: durations.map(d => Number(d)), parentIds })
             });
             if (!res.ok) throw new Error('Failed to create markets');
             toast({ title: "Success", description: "Markets created in Supabase." });
             void fetchMarkets();
             setQuestion('');
             setOptions('');
             setDeadline('');
         } catch (error: unknown) {
             toast({ title: "Error", description: error instanceof Error ? error.message : 'Unknown error', variant: "destructive" });
         } finally {
             setIsCreating(false);
         }
     } else {
         const optionsArray = options.split(',').map(o => o.trim()).filter(o => o.length > 0);
         if (optionsArray.length < 2) {
             toast({ title: "Error", description: "At least 2 options are required for a Custom Market", variant: "destructive" });
             return;
         }

         setIsCreating(true);
         try {
             const res = await fetch('/api/markets/create', {
                 method: 'POST',
                 headers: { 'Content-Type': 'application/json' },
                 body: JSON.stringify({ question: formattedQuestion, options: optionsArray, duration: durationSeconds, parentMarketId: 0 })
             });
             if (!res.ok) throw new Error('Failed to create market');
             toast({ title: "Success", description: "Market created in Supabase." });
             void fetchMarkets();
             setQuestion('');
             setOptions('');
             setDeadline('');
         } catch (error: unknown) {
             toast({ title: "Error", description: error instanceof Error ? error.message : 'Unknown error', variant: "destructive" });
         } finally {
             setIsCreating(false);
         }
     }
  };

  const handleAddSubMarketsSubmit = async () => {
      if (!selectedParentId || !selectedParentQuestion || !selectedParentDeadline) return;

      const durationSeconds = Math.floor(Number(selectedParentDeadline) - (Date.now() / 1000));
      if (durationSeconds <= 0) {
          toast({ title: "Error", description: "Parent market is already expired.", variant: "destructive" });
          return;
      }

      const questions: string[] = [];
      const optionsArr: string[][] = [];
      const durations: bigint[] = [];
      const parentIds: bigint[] = [];

      const pId = BigInt(selectedParentId);
      const dur = BigInt(durationSeconds);

      if (subMarketPresets.btts) {
          questions.push(`${selectedParentQuestion} (BTTS)`);
          optionsArr.push(["Yes", "No"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.ou05) {
          questions.push(`${selectedParentQuestion} (Over/Under 0.5 Goals)`);
          optionsArr.push(["Over 0.5", "Under 0.5"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.ou15) {
          questions.push(`${selectedParentQuestion} (Over/Under 1.5 Goals)`);
          optionsArr.push(["Over 1.5", "Under 1.5"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.ou25) {
          questions.push(`${selectedParentQuestion} (Over/Under 2.5 Goals)`);
          optionsArr.push(["Over 2.5", "Under 2.5"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.ou35) {
          questions.push(`${selectedParentQuestion} (Over/Under 3.5 Goals)`);
          optionsArr.push(["Over 3.5", "Under 3.5"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.ou45) {
          questions.push(`${selectedParentQuestion} (Over/Under 4.5 Goals)`);
          optionsArr.push(["Over 4.5", "Under 4.5"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.doubleChance) {
          questions.push(`${selectedParentQuestion} (Double Chance)`);
          optionsArr.push(["Home or Draw", "Away or Draw", "Home or Away"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.drawNoBet) {
          questions.push(`${selectedParentQuestion} (Draw No Bet)`);
          optionsArr.push(["Home", "Away"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.exactGoals) {
          questions.push(`${selectedParentQuestion} (Exact Goals)`);
          optionsArr.push(["0", "1", "2", "3", "4+"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.halftimeResult) {
          questions.push(`${selectedParentQuestion} (Half-Time Result)`);
          optionsArr.push(["Home", "Draw", "Away"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.bttsFirstHalf) {
          questions.push(`${selectedParentQuestion} (BTTS - 1st Half)`);
          optionsArr.push(["Yes", "No"]);
          durations.push(dur);
          parentIds.push(pId);
      }
      if (subMarketPresets.firstTeamToScore) {
          questions.push(`${selectedParentQuestion} (First Team to Score)`);
          optionsArr.push(["Home", "Away", "None"]);
          durations.push(dur);
          parentIds.push(pId);
      }

      if (customSubMarketName && customSubMarketOptions) {
          const opts = customSubMarketOptions.split(',').map(o => o.trim()).filter(o => o.length > 0);
          if (opts.length >= 2) {
              questions.push(`${selectedParentQuestion} (${customSubMarketName})`);
              optionsArr.push(opts);
              durations.push(dur);
              parentIds.push(pId);
          }
      }

      if (questions.length === 0) {
          toast({ title: "Error", description: "Select at least one sub-market to add.", variant: "destructive" });
          return;
      }

      setIsCreating(true);
      try {
          const res = await fetch('/api/markets/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ isBatch: true, questions, optionsArr, durations: durations.map(d => Number(d)), parentIds: parentIds.map(p => Number(p)) })
          });
          if (!res.ok) throw new Error('Failed to add submarkets');
          toast({ title: "Success", description: "Sub-markets added to Supabase." });
          void fetchMarkets();
          setIsAddSubMarketsModalOpen(false);
      } catch (error: unknown) {
          toast({ title: "Error", description: error instanceof Error ? error.message : 'Unknown error', variant: "destructive" });
      } finally {
          setIsCreating(false);
      }
  };

  const handleCommitBetState = () => {
    if (!manualMerkleMarketId || !manualMerkleRoot || !manualTotalPool) return;
    writeContract({
        address: TRUTH_MARKET_ADDRESS as `0x${string}`,
        abi: TRUTH_MARKET_ABI,
        functionName: 'commitBetState',
        args: [manualMerkleMarketId, manualMerkleRoot as `0x${string}`, BigInt(manualTotalPool)],
    });
  };

  const handleResolveMarketV2 = () => {
    if (!manualResolveMarketId || !manualWinningOutcome || !manualDistAmount) return;
    writeContract({
        address: TRUTH_MARKET_ADDRESS as `0x${string}`,
        abi: TRUTH_MARKET_ABI,
        functionName: 'resolveMarket',
        args: [manualResolveMarketId, manualWinningOutcome, BigInt(manualDistAmount)],
    });
  };

  const handleHeartbeat = () => {
    writeContract({
        address: TRUTH_MARKET_ADDRESS as `0x${string}`,
        abi: TRUTH_MARKET_ABI,
        functionName: 'heartbeat',
    });
  };

  const handleResolveSubmit = (marketIdToResolve: string) => {
      if (!marketIdToResolve || !winningOptionIndex) {
          toast({
              title: "Error",
              description: "Please enter the winning option index",
              variant: "destructive"
          });
          return;
      }

      // In Pivot Phase 2.5, Resolution must be handled by the backend CRON or Admin API.
      // We stub this for now to pass compilation as the smart contract resolveMarket changed signatures.
      console.log("Resolve:", marketIdToResolve, winningOptionIndex);
  };

  return (
    <div className="container mx-auto p-8 space-y-8">
      <div className="flex justify-between items-center">
        <h1 className="text-3xl font-bold">Admin Dashboard</h1>
        <div className="text-sm text-muted-foreground bg-secondary px-4 py-2 rounded-md">
           Connected: <span className="font-mono text-foreground">{address || 'Not Connected'}</span>
        </div>
      </div>

      <Tabs defaultValue="management" className="w-full">
          <TabsList className="grid w-full max-w-md grid-cols-2">
              <TabsTrigger value="management">Tab 1: Market Management</TabsTrigger>
              <TabsTrigger value="settlement">Tab 2: V2 Settlement Engine</TabsTrigger>
          </TabsList>

          {/* TAB 1: MARKET MANAGEMENT (SUPABASE REWIRED) */}
          <TabsContent value="management" className="space-y-8 mt-6">
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
            onClick={() => void handleCreateSubmit()}
            disabled={isCreating}
          >
            {isCreating ? 'Creating...' : 'Create Market'}
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
                {(marketsData || []).map((market) => {
                  const marketId = market.id;
                  const question = market.question;
                  const resolved = market.status === 'resolved';
                  const voided = false; // Add void logic in future
                  const totalPool = BigInt(0); // Add aggregate pool logic
                  const bettingEndsAt = new Date(market.closes_at).getTime() / 1000;
                  const creator = 'Admin'; // Update schema if needed
                  const parentMarketId = market.parent_market_id || 0;

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
                  const isParent = Number(parentMarketId) === 0;

                  return (
                    <Fragment key={marketId.toString()}>
                        <TableRow className={!isParent ? "bg-muted/30" : ""}>
                          <TableCell className="font-mono">
                              {marketId.toString()}
                              {!isParent && <div className="text-xs text-muted-foreground mt-1">↳ Parent: {parentMarketId.toString()}</div>}
                          </TableCell>
                          <TableCell className="max-w-xs truncate" title={question}>{question}</TableCell>
                          <TableCell>{categoryLabel}</TableCell>
                          <TableCell>{formatUnits(totalPool, 18)} tNGN</TableCell>
                          <TableCell>
                            <Badge variant={status === "Active" ? "open" : status === "Resolving" ? "secondary" : "outline"}>
                              {status}
                            </Badge>
                          </TableCell>
                          <TableCell>
                             <Badge variant={source === "Bot" ? "outline" : "default"}>{source}</Badge>
                          </TableCell>
                          <TableCell className="space-x-2 flex flex-wrap gap-2">
                            {isParent && status === "Active" && (
                              <Button
                                variant="secondary"
                                size="sm"
                                onClick={() => {
                                    setSelectedParentId(marketId.toString());
                                    setSelectedParentQuestion(question);
                                    setSelectedParentDeadline(BigInt(Math.floor(bettingEndsAt)));
                                    setIsAddSubMarketsModalOpen(true);
                                }}
                              >
                                Add Sub-Markets
                              </Button>
                            )}
                            {(status === "Active" || status === "Resolving") && !resolved && !voided && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setResolvingMarketId(resolvingMarketId === marketId.toString() ? null : marketId.toString())}
                              >
                                {resolvingMarketId === marketId.toString() ? 'Cancel' : 'Resolve'}
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>

                        {/* INLINE RESOLVE ROW */}
                        {resolvingMarketId === marketId.toString() && (
                            <TableRow>
                                <TableCell colSpan={7} className="bg-muted/50 p-4">
                                    <div className="flex items-end gap-4 max-w-lg">
                                        <div className="space-y-2 flex-1">
                                            <label className="text-sm font-medium">Winning Option Index</label>
                                            <Input
                                                type="number"
                                                placeholder="e.g. 0 for first option, 1 for second..."
                                                value={winningOptionIndex}
                                                onChange={(e) => setWinningOptionIndex(e.target.value)}
                                            />
                                        </div>
                                        <Button
                                            variant="destructive"
                                            onClick={() => handleResolveSubmit(marketId.toString())}
                                        >
                                            Confirm Resolution
                                        </Button>
                                    </div>
                                </TableCell>
                            </TableRow>
                        )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ADD SUB-MARKETS MODAL (PRESET GRID) */}
      <Dialog open={isAddSubMarketsModalOpen} onOpenChange={setIsAddSubMarketsModalOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add Sub-Markets to #{selectedParentId}</DialogTitle>
            <DialogDescription>
              Select popular sub-markets to attach to: <strong>{selectedParentQuestion}</strong>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-btts" checked={subMarketPresets.btts} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, btts: c === true})} />
                    <label htmlFor="sm-btts" className="text-sm cursor-pointer select-none flex-1">BTTS (Yes/No)</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ou05" checked={subMarketPresets.ou05} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, ou05: c === true})} />
                    <label htmlFor="sm-ou05" className="text-sm cursor-pointer select-none flex-1">O/U 0.5 Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ou15" checked={subMarketPresets.ou15} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, ou15: c === true})} />
                    <label htmlFor="sm-ou15" className="text-sm cursor-pointer select-none flex-1">O/U 1.5 Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ou25" checked={subMarketPresets.ou25} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, ou25: c === true})} />
                    <label htmlFor="sm-ou25" className="text-sm cursor-pointer select-none flex-1">O/U 2.5 Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ou35" checked={subMarketPresets.ou35} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, ou35: c === true})} />
                    <label htmlFor="sm-ou35" className="text-sm cursor-pointer select-none flex-1">O/U 3.5 Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ou45" checked={subMarketPresets.ou45} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, ou45: c === true})} />
                    <label htmlFor="sm-ou45" className="text-sm cursor-pointer select-none flex-1">O/U 4.5 Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-dc" checked={subMarketPresets.doubleChance} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, doubleChance: c === true})} />
                    <label htmlFor="sm-dc" className="text-sm cursor-pointer select-none flex-1">Double Chance</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-dnb" checked={subMarketPresets.drawNoBet} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, drawNoBet: c === true})} />
                    <label htmlFor="sm-dnb" className="text-sm cursor-pointer select-none flex-1">Draw No Bet</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-eg" checked={subMarketPresets.exactGoals} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, exactGoals: c === true})} />
                    <label htmlFor="sm-eg" className="text-sm cursor-pointer select-none flex-1">Exact Goals</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-ht" checked={subMarketPresets.halftimeResult} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, halftimeResult: c === true})} />
                    <label htmlFor="sm-ht" className="text-sm cursor-pointer select-none flex-1">Half-Time Result</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-btts1" checked={subMarketPresets.bttsFirstHalf} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, bttsFirstHalf: c === true})} />
                    <label htmlFor="sm-btts1" className="text-sm cursor-pointer select-none flex-1">BTTS - 1st Half</label>
                </div>
                <div className="flex items-center space-x-2 border p-3 rounded-md hover:bg-muted/50 transition-colors">
                    <Checkbox id="sm-f2s" checked={subMarketPresets.firstTeamToScore} onCheckedChange={(c) => setSubMarketPresets({...subMarketPresets, firstTeamToScore: c === true})} />
                    <label htmlFor="sm-f2s" className="text-sm cursor-pointer select-none flex-1">First to Score</label>
                </div>
            </div>

            <div className="pt-4 border-t">
              <h4 className="text-sm font-medium mb-3">Custom Sub-Market</h4>
              <div className="grid grid-cols-2 gap-4">
                  <div>
                      <label className="text-xs mb-1 block">Market Name (e.g. &quot;Total Corners&quot;)</label>
                      <Input value={customSubMarketName} onChange={(e) => setCustomSubMarketName(e.target.value)} />
                  </div>
                  <div>
                      <label className="text-xs mb-1 block">Options (Comma separated)</label>
                      <Input value={customSubMarketOptions} onChange={(e) => setCustomSubMarketOptions(e.target.value)} placeholder="Over 10, Under 10" />
                  </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddSubMarketsModalOpen(false)}>Cancel</Button>
            <Button
              onClick={() => void handleAddSubMarketsSubmit()}
              disabled={isCreating}
            >
              {isCreating ? 'Adding...' : 'Add Selected Sub-Markets'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
          </TabsContent>

          {/* TAB 2: V2 SETTLEMENT ENGINE */}
          <TabsContent value="settlement" className="space-y-8 mt-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {/* Heartbeat Escape Hatch */}
                  <Card className="border-red-500/50 bg-red-500/5">
                      <CardHeader>
                          <CardTitle className="text-red-500 flex items-center gap-2">
                              Escape Hatch Reset (Heartbeat)
                          </CardTitle>
                          <DialogDescription className="text-red-400/80">
                              Must be called every 30 days to prevent users from bypassing the vault.
                          </DialogDescription>
                      </CardHeader>
                      <CardContent>
                          <Button
                              variant="destructive"
                              className="w-full h-16 text-lg font-bold shadow-[0_0_20px_rgba(239,68,68,0.5)] hover:shadow-[0_0_30px_rgba(239,68,68,0.8)] transition-all"
                              onClick={handleHeartbeat}
                              disabled={isTxPending}
                          >
                              {isTxPending ? 'Sending Pulse...' : 'TRANSMIT HEARTBEAT'}
                          </Button>
                      </CardContent>
                  </Card>

                  {/* Manual Merkle Commit */}
                  <Card>
                      <CardHeader>
                          <CardTitle>Manual Merkle Commit</CardTitle>
                          <DialogDescription>Fallback for cron failure. Lock bet state on-chain.</DialogDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                          <Input placeholder="Market ID" value={manualMerkleMarketId} onChange={(e) => setManualMerkleMarketId(e.target.value)} />
                          <Input placeholder="Merkle Root (0x...)" value={manualMerkleRoot} onChange={(e) => setManualMerkleRoot(e.target.value)} />
                          <Input placeholder="Total Pool (Wei)" value={manualTotalPool} onChange={(e) => setManualTotalPool(e.target.value)} />
                          <Button className="w-full" onClick={handleCommitBetState} disabled={isTxPending}>Commit State</Button>
                      </CardContent>
                  </Card>

                  {/* Manual Market Resolution */}
                  <Card>
                      <CardHeader>
                          <CardTitle>Manual V2 Resolution</CardTitle>
                          <DialogDescription>Unlock the vault and return funds to Master Wallet.</DialogDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                          <Input placeholder="Market ID" value={manualResolveMarketId} onChange={(e) => setManualResolveMarketId(e.target.value)} />
                          <Input placeholder="Winning Outcome String" value={manualWinningOutcome} onChange={(e) => setManualWinningOutcome(e.target.value)} />
                          <Input placeholder="Distribution Amount (Wei)" value={manualDistAmount} onChange={(e) => setManualDistAmount(e.target.value)} />
                          <Button className="w-full" onClick={handleResolveMarketV2} disabled={isTxPending}>Resolve & Unlock</Button>
                      </CardContent>
                  </Card>
              </div>
          </TabsContent>
      </Tabs>
    </div>
  );
}
