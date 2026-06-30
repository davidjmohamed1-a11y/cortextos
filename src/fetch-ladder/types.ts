/**
 * Shared types for the fetch-ladder subsystem.
 *
 * Spec: orgs/personal/agents/forge/specs/fetch-ladder-2026-06-30.md
 * Design source: orgs/personal/reference/fetch-ladder-design-2026-06-30.md
 */

/** Rung numbers in the legal fetch ladder. */
export type Rung = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Rungs implemented in Phase 1. Phase 2 adds 5 + 6. */
export const PHASE_1_RUNGS: ReadonlyArray<Rung> = [0, 1, 2, 3, 4];

/**
 * Why a fetch attempt at a given rung failed. Drives escalation:
 *   - 'content' → escalate to next rung
 *   - 'policy' → STOP + flag (legal or operational bright-line)
 *   - 'transport' → retry with back-off; escalate if persistent
 */
export type FailReason = 'content' | 'policy' | 'transport';

/**
 * A single fetch attempt outcome (one rung's result). The orchestrator
 * concatenates these into FetchResult.attempts for full traceability.
 */
export interface FetchAttempt {
  rung: Rung;
  ok: boolean;
  fail_reason?: FailReason;
  detail?: string;
  bytes?: number;
  fetched_at: string;
}

/**
 * Final result of fetchUrl(). Includes the consumed content (success path)
 * plus the full attempt history so callers can show why each rung failed.
 */
export interface FetchResult {
  url: string;
  success: boolean;
  rung_succeeded?: Rung;
  content?: string;
  content_type?: string;
  facts?: Record<string, unknown>;
  needs_human_gate?: boolean;
  do_not_attempt?: boolean;
  attempts: FetchAttempt[];
  policy_after: SitePolicy;
}

/**
 * Per-registrable-domain policy cache. Stored at
 *   <ctxRoot>/state/fetch-ladder/site-policy/<domain>.json
 * Atomic writes. TTL ~weekly by default.
 *
 * Per spec: `best_rung` is the rung to START at next time (skip lower rungs
 * we already know won't have data for this domain). `blocked_rungs` are
 * rungs that failed twice in a row → skip permanently until TTL expiry.
 */
export interface SitePolicy {
  /** Registrable domain (e.g. 'notion.so', not 'www.notion.so'). */
  domain: string;
  robots?: {
    allowed: boolean;
    crawl_delay_ms?: number;
    sitemap?: string;
    fetched_at: string;
  };
  /** Loose ToS classification (set by rung 0 + manual operator overrides). */
  tos_flag?: 'permissive' | 'login_required' | 'forbidden';
  /** Start here next time. Updated on success-with-promotion. */
  best_rung?: Rung;
  /** Rungs to skip — failed twice in a row. */
  blocked_rungs: Rung[];
  /** Known official API for this domain, if any. */
  api?: {
    exists: boolean;
    base?: string;
    auth_required?: boolean;
    /** Env-var name where the API key lives (e.g. 'NOTION_API_KEY'). */
    auth_env?: string;
  };
  /** Structured-data kinds observed on this domain. */
  structured_data_kinds?: string[];
  /** Anti-bot system observed (sets best_rung floor in Phase 2). */
  anti_bot_observed?: 'cloudflare' | 'turnstile' | 'recaptcha' | 'none';
  /** Operator/orchestrator hint: needs Phase 2 rung 6 human handshake. */
  needs_human_gate?: boolean;
  /** Hard legal stop — never auto-fetch (e.g. requires login to gated data). */
  do_not_attempt?: boolean;
  last_success?: { rung: Rung; at: string };
  last_fail?: { rung: Rung; at: string; reason: string };
  /** Counts consecutive failures per rung (for demote-on-fail). */
  fail_streak?: Partial<Record<Rung, number>>;
  updated_at: string;
  /** TTL window. After this much elapsed wall-time, treat policy as stale and
   * re-check rung 0 (robots) before reusing best_rung. */
  ttl_hours: number;
}

/** Default TTL for a SitePolicy entry. */
export const SITE_POLICY_DEFAULT_TTL_HOURS = 168; // 1 week

/**
 * Consecutive failures at a rung before we add it to blocked_rungs.
 * Two failures because transient errors are common; three is too forgiving.
 */
export const RUNG_BLOCK_THRESHOLD = 2;
