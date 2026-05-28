'use client';

import { supabase } from '@/lib/supabase';
import { useState } from 'react';

export default function BotTestPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleBotLogin = async () => {
    setLoading(true);
    setError('');
    try {
      const email = 'bot1@odds.ng';
      const otp = '123456';
      const bypassRes = await fetch('/api/auth/bot-bypass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });

      if (!bypassRes.ok) {
        const errData = await bypassRes.json();
        throw new Error(errData.error || 'Bot bypass failed');
      }

      const { token_hash } = await bypassRes.json();
      if (!token_hash) throw new Error('No token hash returned');

      // Verify the extracted token_hash client-side so Supabase SDK handles session cookies naturally
      // Note: when verifying a token_hash, Supabase requires ONLY token_hash and type.
      const { error: verifyError } = await supabase.auth.verifyOtp({
        token_hash: token_hash,
        type: 'magiclink',
      });

      if (verifyError) throw verifyError;

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
