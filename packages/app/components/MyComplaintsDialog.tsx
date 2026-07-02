'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Loader2, MessageCircle, CheckCircle2, Clock, Wrench } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MyComplaint {
  id: string;
  reference_code: string;
  type: string;
  status: string;
  ai_triage_category: string | null;
  admin_response: string | null;
  admin_responded_at: string | null;
  created_at: string;
  resolved_at: string | null;
}

// User-facing "My complaint history" — reads /api/user/complaint (GET).
// One place to see everything they've reported and where each one stands.
export function MyComplaintsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [items, setItems] = useState<MyComplaint[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) return;
      const r = await fetch(`/api/user/complaint?_=${Date.now()}`, {
        headers: { Authorization: `Bearer ${session.access_token}` },
        cache: 'no-store',
      });
      if (!r.ok) return;
      const data = await r.json();
      setItems(data.complaints || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const statusLabel = (s: string): { text: string; tone: 'wait' | 'work' | 'done' } => {
    switch (s) {
      case 'submitted':
      case 'mechanic_attempting':
      case 'monitor_review':
        return { text: 'Looking into it', tone: 'wait' };
      case 'mechanic_fixed':
      case 'admin_working':
        return { text: 'Being worked on', tone: 'work' };
      case 'resolved':
      case 'closed':
        return { text: 'Resolved', tone: 'done' };
      default:
        return { text: s, tone: 'wait' };
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="w-4 h-4" />
            My complaints
          </DialogTitle>
          <DialogDescription>
            Everything you&apos;ve reported and where each one stands.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            You haven&apos;t reported anything yet.
          </div>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {items.map(c => {
              const s = statusLabel(c.status);
              return (
                <div key={c.id} className="border rounded-lg p-3 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-mono font-bold text-emerald-300">{c.reference_code}</span>
                    <Badge variant="outline" className="text-[9px] uppercase px-1 py-0">
                      {c.type.replace(/_/g, ' ')}
                    </Badge>
                    <Badge
                      className={cn(
                        'text-[9px] uppercase px-1 py-0',
                        s.tone === 'done' && 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
                        s.tone === 'work' && 'bg-amber-500/20 text-amber-300 border-amber-500/30',
                        s.tone === 'wait' && 'bg-blue-500/20 text-blue-300 border-blue-500/30',
                      )}
                    >
                      {s.tone === 'done' ? <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" /> :
                       s.tone === 'work' ? <Wrench className="w-2.5 h-2.5 mr-0.5" /> :
                                            <Clock className="w-2.5 h-2.5 mr-0.5" />}
                      {s.text}
                    </Badge>
                  </div>
                  {c.admin_response && (
                    <div className="text-xs bg-emerald-500/10 border border-emerald-500/20 rounded-md p-2 whitespace-pre-wrap">
                      <span className="text-emerald-300 font-medium">Response · </span>
                      <span>{c.admin_response}</span>
                    </div>
                  )}
                  <p className="text-[10px] text-muted-foreground">
                    Filed {new Date(c.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    {c.resolved_at && ` · resolved ${new Date(c.resolved_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}`}
                  </p>
                </div>
              );
            })}
          </div>
        )}

        <div className="pt-2 border-t border-border">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} className="w-full">
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
