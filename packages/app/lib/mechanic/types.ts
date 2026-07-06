// Shared shapes for Monitor & Mechanic.

export type IssueCategory =
  | 'settlement'
  | 'balance'
  | 'deposit'
  | 'withdrawal'
  | 'market'
  | 'complaint_auto_fix'
  | 'post_deploy'
  | 'manual';

export type CascadeTier =
  // Auto-applied by the heartbeat cron. No user balance impact,
  // idempotent, reversible. Runs without human approval.
  | 'safe_auto'
  // Detected by scan, but a human must click Fix. Money moves.
  | 'approval_required';

export interface Finding {
  // Deterministic key so re-scans dedup against system_alerts and
  // mechanic_log naturally. Format: "<issueType>:<primaryIdentifier>".
  fingerprint: string;
  category: IssueCategory;
  issueType: string;              // 'stuck_slip' | 'orphaned_leg' | ...
  severity: 'info' | 'warning' | 'critical';
  tier: CascadeTier;
  title: string;                  // one-line human summary
  detail: string;                 // longer human explanation
  // Primary IDs the fix will operate on. Fix dispatcher matches on
  // issueType and reads these to know what to do.
  affectedIds: {
    slipId?: string;
    slipIds?: string[];
    legId?: string;
    legIds?: string[];
    betId?: string;
    betIds?: string[];
    marketId?: number;
    marketIds?: number[];
    userId?: string;
    userIds?: string[];
  };
  // Extra context to render in the /ops card.
  meta?: Record<string, any>;
  // What we'd do if Fix were clicked. Populated for approval_required
  // findings so preview-before-apply can show the delta before firing.
  proposedFix?: {
    endpoint: string;             // e.g. '/api/admin/repair-multiplier-legs'
    method: 'POST';
    body: any;
    dryRun: boolean;              // whether the endpoint supports a dry-run mode
  };
}

export interface ScanResult {
  runId: string;
  scannedAt: string;
  scopeApplied: IssueCategory[];  // which categories were run this pass
  findings: Finding[];
  countsByCategory: Record<IssueCategory, number>;
  totalFindings: number;
  scanErrors: Array<{ category: IssueCategory; error: string }>;
  durationMs: number;
}
