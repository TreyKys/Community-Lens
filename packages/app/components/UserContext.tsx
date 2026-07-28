'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccount } from 'wagmi';

/**
 * Cryptographically secure id for a new non-custodial profile.
 *
 * Prefers crypto.randomUUID, then a getRandomValues-built UUIDv4. Never uses
 * Math.random(): it's a predictable PRNG, so ids derived from it can be guessed
 * from previously observed ones — unacceptable for a user identifier.
 */
function randomId(): string {
  const c: Crypto | undefined = typeof globalThis !== 'undefined' ? (globalThis as any).crypto : undefined;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
    const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  // No WebCrypto at all — refuse rather than mint a guessable id.
  throw new Error('Secure random source unavailable; cannot create a profile id.');
}

export interface UserState {
  id: string;
  wallet_address: string;
  tngn_balance: number;
  bonus_balance: number;
  is_custodial: boolean;
}

interface UserContextProps {
  user: UserState | null;
  isLoading: boolean;
  refreshUser: () => Promise<void>;
  logoutUser: () => void;
}

const UserContext = createContext<UserContextProps>({
  user: null,
  isLoading: true,
  refreshUser: async () => {},
  logoutUser: () => {},
});

export const UserProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<UserState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { address } = useAccount();

  const fetchUserFromDB = async (queryColumn: 'id' | 'wallet_address', queryValue: string) => {
    try {
      const { data, error } = await supabase
        .from('users')
        .select('id, wallet_address, tngn_balance, bonus_balance, is_custodial')
        .eq(queryColumn, queryValue)
        .single();

      if (data && !error) {
        setUser(data as UserState);
        return data as UserState;
      }
    } catch (err) {
      console.error('Failed to fetch user:', err);
    }
    return null;
  };

  const loadUser = async () => {
    setIsLoading(true);

    // 1. Check for native Supabase OTP session
    const sessionStr = localStorage.getItem('truthmarket_user');
    if (sessionStr) {
      try {
        const parsed = JSON.parse(sessionStr);
        if (parsed.id) {
          await fetchUserFromDB('id', parsed.id);
          setIsLoading(false);
          return;
        }
      } catch (e: unknown) {
        console.error('Failed to parse user session', e);
      }
    }

    // 2. Fallback to Web3 Connected Wallet
    if (address) {
      const dbUser = await fetchUserFromDB('wallet_address', address.toLowerCase());

      // If Web3 user connects for the first time, auto-create a non-custodial profile
      if (!dbUser) {
          // Math.random() is NOT cryptographically secure — its output is
          // predictable from prior draws, so a fallback built on it could let
          // an attacker guess the id of a freshly-created wallet profile.
          // Use crypto.getRandomValues (available wherever crypto.randomUUID
          // isn't) and only fall back further if there is no WebCrypto at all.
          const newId = randomId();
          const { data, error } = await supabase.from('users').insert({
              id: newId,
              wallet_address: address.toLowerCase(),
              is_custodial: false,
              tngn_balance: 0,
              bonus_balance: 0,
          }).select().single();

          if (data && !error) {
              setUser(data as UserState);
          }
      }
      setIsLoading(false);
      return;
    }

    setUser(null);
    setIsLoading(false);
  };

  useEffect(() => {
    void loadUser();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]); // Reload if Web3 address changes

  const refreshUser = async () => {
    if (user?.id) {
        await fetchUserFromDB('id', user.id);
    } else if (address) {
        await fetchUserFromDB('wallet_address', address.toLowerCase());
    }
  };

  const logoutUser = () => {
    localStorage.removeItem('truthmarket_user');
    setUser(null);
  };

  return (
    <UserContext.Provider value={{ user, isLoading, refreshUser, logoutUser }}>
      {children}
    </UserContext.Provider>
  );
};

export const useUser = () => useContext(UserContext);
