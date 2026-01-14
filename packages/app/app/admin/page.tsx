'use client';

import { useAccount } from 'wagmi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useState, useEffect } from 'react';

export default function AdminPage() {
  const { address } = useAccount();
  const [isMounted, setIsMounted] = useState(false);
  const adminAddress = process.env.NEXT_PUBLIC_ADMIN_ADDRESS;

  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [duration, setDuration] = useState('');

  useEffect(() => {
    setIsMounted(true);
  }, []);

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
     // TODO: Implement contract write logic in next phase
     // Logic: Split options by comma, convert duration (hours) to seconds
     console.log('Creating market:', {
        question,
        options: options.split(',').map(o => o.trim()),
        durationSeconds: Number(duration) * 3600
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

          <Button className="w-full" onClick={handleSubmit}>Create Market</Button>
        </CardContent>
      </Card>
    </div>
  );
}
