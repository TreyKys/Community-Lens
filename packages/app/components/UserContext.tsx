'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { supabase } from '@/lib/supabase';
import { useAccount } from 'wagmi';

export interface UserState {
  id: string;
  wallet_address: string;
  tngn_balance: number;
  free_bet_credits: number;
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
        .select('id, wallet_address, tngn_balance, free_bet_credits, is_custodial')
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
          const newId = window.crypto.randomUUID ? window.crypto.randomUUID() : Math.random().toString(36).substring(2, 15);
          const { data, error } = await supabase.from('users').insert({
              id: newId,
              wallet_address: address.toLowerCase(),
              is_custodial: false,
              tngn_balance: 0,
              free_bet_credits: 0
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
