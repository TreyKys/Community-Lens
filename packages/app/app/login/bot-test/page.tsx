'use client';

import { supabase } from '@/lib/supabase';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function BotTestPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleBotLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const email = 'bot1@odds.ng';

      const bypassRes = await fetch('/api/auth/bot-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!bypassRes.ok) {
        const errData = await bypassRes.json();
        throw new Error(errData.error || 'Bot bypass failed');
      }

      const { session } = await bypassRes.json();

      if (!session) {
         throw new Error('No session returned from bypass endpoint');
      }

      const { error: setSessionError } = await supabase.auth.setSession(session);
      if (setSessionError) throw setSessionError;

      // If successful, redirect to dashboard
      window.location.href = '/dashboard';
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Bot Login Test</h1>
      {error && <p className="text-red-500 mb-4">{error}</p>}
      <button
        onClick={handleBotLogin}
        disabled={loading}
        className="px-4 py-2 bg-blue-600 text-white rounded"
      >
        {loading ? 'Logging in...' : 'Login as bot1@odds.ng'}
      </button>
    </div>
  );
}
