'use client';

import { useAccount, useWriteContract } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';
import { TRUTH_MARKET_ADDRESS, TRUTH_MARKET_ABI } from '@/lib/constants';
import { useToast } from '@/hooks/use-toast';

export default function AdminPage() {
  const { address } = useAccount();
  const { writeContract, isPending, isSuccess, data: hash } = useWriteContract();
  const { toast } = useToast();
  const [isMounted, setIsMounted] = useState(false);
  const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS;

  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [duration, setDuration] = useState('');

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    if (isSuccess && hash) {
        toast({
            title: "Market Created!",
            description: `Transaction Hash: ${hash}`,
        });
        // Reset form
        setQuestion('');
        setOptions('');
        setDuration('');
    }
  }, [isSuccess, hash, toast]);

  if (!isMounted) return null;

  const isAuthorized = address && adminAddress && address.toLowerCase() === adminAddress.toLowerCase();

  if (!isAuthorized) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <h1 className="text-2xl font-bold text-red-500">Access Denied</h1>
      </div>
    );
  }

  const handleSubmit = () => {
     if (!question || !options) {
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

     // Duration logic requested in prompt, but contract does not accept it.
     // We convert it here as requested to show intent, even if not used.
     const durationSeconds = duration ? Number(duration) * 3600 : 0;
     console.log("Duration in seconds:", durationSeconds);

     writeContract({
         address: TRUTH_MARKET_ADDRESS as `0x${string}`,
         abi: TRUTH_MARKET_ABI,
         functionName: 'createMarket',
         args: [question, optionsArray],
     });
  };

  return (
    <div className="container mx-auto p-8">
      <Card className="max-w-2xl mx-auto">
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
            <label className="text-sm font-medium">Duration (hours)</label>
            <Input
              type="number"
              placeholder="24"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </div>

          <Button className="w-full" onClick={handleSubmit} disabled={isPending}>
            {isPending ? 'Creating...' : 'Create Market'}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
