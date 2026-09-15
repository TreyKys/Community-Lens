'use client';

import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import type { OddsPreviewRow } from '@/lib/lockedOddsAdminPreview';

// ── The confirmation gate itself ─────────────────────────────────────────
//
// Blocking, not passive. A live opening-odds preview already sat inside
// the locked-odds config form before this existed, and it didn't stop an
// admin from creating a market whose odds turned out very different from
// what they intended — it's easy to glance past a number sitting in a
// form you're mid-filling. This is the thing that has to be looked at and
// explicitly agreed to before a locked-odds market can actually be
// created or converted — on both surfaces that do that: the plain Create
// form and the legacy-market "migrate to locked-odds" dialog.
export function LockedOddsConfirmDialog({
  open, onOpenChange, question, options, preview, effectiveVigPct, categoryVigPct,
  onConfirm, confirming,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  question: string;
  options: string[];
  preview: OddsPreviewRow[] | null;
  effectiveVigPct: number;
  categoryVigPct: number;
  onConfirm: () => void;
  confirming: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm the odds users will actually see</DialogTitle>
          <DialogDescription>
            This is the same math the app runs when someone stakes — not a rounded estimate.
            Once you confirm, these are the numbers that go live.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-sm font-medium leading-snug">{question || '(no question set)'}</p>

          {Math.abs(effectiveVigPct - categoryVigPct) > 0.001 && (
            <p className="text-[11px] text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded px-2 py-1.5">
              Vig override in effect: {(effectiveVigPct * 100).toFixed(0)}% — the category default for this market would be {(categoryVigPct * 100).toFixed(0)}%.
            </p>
          )}

          {preview ? (
            <div className="rounded-md border border-border/60 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/60 bg-muted/30">
                    <th className="text-left font-medium px-2 py-1.5">Stake</th>
                    {options.map((o, i) => (
                      <th key={i} className="text-right font-medium px-2 py-1.5">{o || `Outcome ${i}`}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {preview.map(row => (
                    <tr key={row.stake} className="border-b border-border/30 last:border-0">
                      <td className="px-2 py-1.5">
                        <div className="tabular-nums">₦{row.stake.toLocaleString()}</div>
                        <div className="text-[9px] text-muted-foreground">{row.label}</div>
                      </td>
                      {row.perOutcome.map((r, i) => (
                        <td key={i} className="text-right px-2 py-1.5 tabular-nums">
                          {r ? <span className="font-bold">{r.lockedOdds.toFixed(2)}×</span> : '—'}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Odds preview isn&rsquo;t available for the current settings.</p>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            Go back and adjust
          </Button>
          <Button onClick={onConfirm} disabled={confirming || !preview} className="gap-2">
            {confirming && <Loader2 className="w-4 h-4 animate-spin" />}
            These are the odds — confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
