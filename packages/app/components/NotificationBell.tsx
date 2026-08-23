'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Bell } from 'lucide-react';

// One table for both the list icon and the arrival toast. They were two
// separate inline ternaries, which is how a type ends up with an icon in the
// list and "Notification" as its toast title — visibly the same event
// presented two different ways.
const NOTIF_STYLE: Record<string, { icon: string; title: string }> = {
  bet_won:                  { icon: '🎉', title: '🎉 You called it!' },
  bet_lost:                 { icon: '💔', title: 'Result is in' },
  bet_insurance_refund:     { icon: '🛡', title: '🛡 Protection Applied' },
  first_bet_refund:         { icon: '🛡', title: '🛡 Protection Applied' },
  share_staked:             { icon: '🔥', title: '🔥 Your pick is spreading!' },
  deposit:                  { icon: '💰', title: 'Deposit' },
  deposit_credited:         { icon: '💰', title: 'Money in' },
  withdrawal:               { icon: '💸', title: 'Withdrawal' },
  weekly_rebate:            { icon: '💎', title: 'Rebate' },
  complaint_received:       { icon: '📨', title: 'We got your message' },
  complaint_response:       { icon: '💬', title: 'Support replied' },
  void_loss_recovery:       { icon: '↩️', title: 'Refunded' },
  bonus_split_correction:   { icon: '⚖️', title: 'Balance corrected' },
  multiplier_won:           { icon: '🎯', title: '🎯 Slip landed!' },
  multiplier_lost:          { icon: '💔', title: 'Slip missed' },
  multiplier_voided:        { icon: '↩️', title: 'Slip voided' },
  welcome_match:            { icon: '🎁', title: '🎁 Bonus added' },
  // Streaks, rewards and the trading engine. Without these every one of them
  // arrived as a generic bell and the word "Notification" — the reward paths
  // are the ones most meant to feel like something happened.
  streak_reward:            { icon: '🔥', title: '🔥 Streak complete!' },
  profile_reward:           { icon: '🎁', title: '🎁 Bonus added' },
  open_market_payout:       { icon: '🎉', title: '🎉 You called it!' },
  open_market_refund:       { icon: '↩️', title: 'Market voided' },
  open_market_horizon:      { icon: '⏰', title: '⏰ Decision needed' },
  open_market_submitted:    { icon: '📝', title: 'With our reviewers' },
  open_market_approve:      { icon: '✅', title: '✅ Your market is live' },
  open_market_revise:       { icon: '✏️', title: 'Changes needed' },
  open_market_reject:       { icon: '🚫', title: 'Not approved' },
  open_market_creator_payout: { icon: '💰', title: '💰 Creator earnings paid' },
};

const notifStyle = (type: string) => NOTIF_STYLE[type] ?? { icon: '🔔', title: 'Notification' };
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

interface Notification {
  id: string;
  type: string;
  message: string;
  amount: number | null;
  is_read: boolean;
  created_at: string;
  // Added by the ops/monitor migration — safe to read even against
  // rows written before it (defaults kick in server-side).
  severity?: 'info' | 'success' | 'warning' | 'critical';
  category?: string | null;
  reference_code?: string | null;
  action_url?: string | null;
}

export function NotificationBell() {
  const [session, setSession] = useState<any>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const { toast } = useToast();

  const unreadCount = notifications.filter(n => !n.is_read).length;

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user?.id) return;

    // Initial fetch
    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', session.user.id)
      .order('created_at', { ascending: false })
      .limit(20)
      .then(({ data }) => setNotifications((data || []) as Notification[]));

    // Real-time subscription
    const channel = supabase
      .channel(`notifications:${session.user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${session.user.id}`,
        },
        (payload) => {
          const newNotif = payload.new as Notification;
          setNotifications(prev => [newNotif, ...prev]);
          // Show toast for new notification
          toast({
            title: notifStyle(newNotif.type).title,
            description: newNotif.message,
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session?.user?.id, toast]);

  const markAllRead = async () => {
    if (!session?.user?.id) return;
    await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', session.user.id)
      .eq('is_read', false);
    setNotifications(prev => prev.map(n => ({ ...n, is_read: true })));
  };

  if (!session) return null;

  return (
    <div className="relative">
      <button
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen && unreadCount > 0) markAllRead();
        }}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg hover:bg-muted transition-colors"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[9px] font-bold text-white">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {isOpen && (
        <>
          {/* Backdrop — clickable, also dims content on mobile */}
          <div
            className="fixed inset-0 z-40 bg-background/40 sm:bg-transparent"
            onClick={() => setIsOpen(false)}
          />

          {/*
            Dropdown
            • Mobile (< sm): full-width sheet pinned to top, slide down. Width is
              viewport minus a small gutter so it never clips. Max height 75vh.
            • Desktop (≥ sm): anchored dropdown at the bell, fixed width 22rem.
          */}
          <div
            className={cn(
              'z-50 bg-popover border border-border rounded-xl shadow-xl overflow-hidden flex flex-col',
              // mobile: fixed full-bleed near top
              'fixed left-2 right-2 top-16 max-h-[75vh]',
              // desktop: anchored to the bell
              'sm:absolute sm:left-auto sm:right-0 sm:top-11 sm:w-[22rem] sm:max-h-[28rem]'
            )}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <span className="text-sm font-semibold">Notifications</span>
              <div className="flex items-center gap-3">
                {unreadCount > 0 && (
                  <button onClick={markAllRead} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    Mark all read
                  </button>
                )}
                <button
                  onClick={() => setIsOpen(false)}
                  className="text-xs text-muted-foreground hover:text-foreground sm:hidden"
                  aria-label="Close notifications"
                >
                  Close
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-border/50 overscroll-contain">
              {notifications.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">
                  No notifications yet
                </div>
              ) : (
                notifications.map(n => (
                  <div
                    key={n.id}
                    className={cn(
                      'px-4 py-3 transition-colors',
                      !n.is_read && 'bg-primary/5'
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-base leading-none mt-0.5">
                        {notifStyle(n.type).icon}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm leading-snug break-words">{n.message}</p>
                        <div className="flex items-center gap-2 mt-1 flex-wrap">
                          <p className="text-xs text-muted-foreground">
                            {new Date(n.created_at).toLocaleDateString('en-NG', {
                              day: 'numeric', month: 'short',
                              hour: '2-digit', minute: '2-digit'
                            })}
                          </p>
                          {n.reference_code && (
                            <span className="text-[10px] font-mono text-emerald-400/80">
                              ref {n.reference_code}
                            </span>
                          )}
                        </div>
                      </div>
                      {!n.is_read && (
                        <div className="w-1.5 h-1.5 rounded-full bg-primary shrink-0 mt-1.5" />
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
