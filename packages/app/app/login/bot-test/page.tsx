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
      const { data, error } = await supabase.auth.signInWithPassword({
        email: 'bot1@odds.ng',
        password: 'OddsNgBotSquad2026!',
      });
      if (error) throw error;

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
