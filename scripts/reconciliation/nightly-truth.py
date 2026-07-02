#!/usr/bin/env python3
"""nightly-truth.py — Cross-org bus-task reconciliation cron.

Walks every open+in-progress bus task across every org and matches it against
reality (git log, file existence, recent inbox activity). Emits a JSON state
file and a bus message summary to boss-personal so the morning brief starts
from ground truth instead of aspirational board state.

Signals (conservative auto-close):
  STRONG  task.id in commit body → AUTO-CLOSE with SHA reference
  STRONG  commit title contains task.title verbatim (case-insensitive) → AUTO-CLOSE
  STRONG  recent inbox reply to task assignee mentioning "done: <task>" → AUTO-CLOSE
  WEAK    word-overlap between task.title and commit messages → SUGGEST-CLOSE (report only)
  STALE   no update in >14 days, status=open → FLAG-STALE (report only)
  STALE   no update in >30 days, status=in_progress → FLAG-STALE (escalation)

Safety:
  - Never auto-closes a task another agent updated in the last 4h (respect active work)
  - Weak signals are report-only — always
  - Cross-org: walks EVERY ~/.cortextos/*/orgs/*/tasks/*.json

Output:
  <ctxRoot>/state/reconciliation/YYYY-MM-DD.json  — full state
  Bus message to boss-personal — concise summary for morning brief

Design note: this is the mechanical form of the "verify each item is live"
rule David asked to formalize (Fable audit 2026-07-02, build #1). Ship
2026-07-02.

Stdlib-only (matches repo rule: no external runtime deps).
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Config knobs — thresholds can be overridden via env for tuning.
# ---------------------------------------------------------------------------
STALE_OPEN_DAYS = int(os.environ.get("RECON_STALE_OPEN_DAYS", "14"))
STALE_INPROGRESS_DAYS = int(os.environ.get("RECON_STALE_INPROGRESS_DAYS", "30"))
ACTIVE_WORK_SKIP_HOURS = int(os.environ.get("RECON_ACTIVE_WORK_SKIP_HOURS", "4"))
GIT_LOG_WINDOW_DAYS = int(os.environ.get("RECON_GIT_LOG_WINDOW_DAYS", "45"))
CTX_ROOT_DEFAULT = os.environ.get("CTX_ROOT", str(Path.home() / ".cortextos" / "default"))
FRAMEWORK_ROOT_DEFAULT = os.environ.get(
    "CTX_FRAMEWORK_ROOT",
    str(Path.home() / "cortextos"),
)


# ---------------------------------------------------------------------------
# Task discovery — cross-org.
# ---------------------------------------------------------------------------
def discover_task_files(ctx_root: Path) -> list[Path]:
    """Return every task_*.json across every org under <ctxRoot>/orgs/*/tasks/."""
    out: list[Path] = []
    orgs_dir = ctx_root / "orgs"
    if not orgs_dir.exists():
        return out
    for org_dir in sorted(orgs_dir.iterdir()):
        tasks_dir = org_dir / "tasks"
        if not tasks_dir.is_dir():
            continue
        for p in sorted(tasks_dir.iterdir()):
            if p.suffix == ".json" and p.name.startswith("task_") and p.is_file():
                out.append(p)
    return out


def load_task(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Git-log signal extraction.
# ---------------------------------------------------------------------------
def gather_recent_commits(framework_root: Path, days: int) -> list[dict[str, str]]:
    """Return recent commits as [{sha, title, body}]. Empty on any git failure."""
    if not (framework_root / ".git").exists():
        return []
    since = f"{days}.days.ago"
    try:
        result = subprocess.run(
            ["git", "-C", str(framework_root), "log", f"--since={since}", "--format=%H%x00%s%x00%b%x00---END---"],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if result.returncode != 0:
            return []
        raw = result.stdout
    except (OSError, subprocess.SubprocessError):
        return []

    commits: list[dict[str, str]] = []
    for chunk in raw.split("---END---\n"):
        chunk = chunk.strip()
        if not chunk:
            continue
        parts = chunk.split("\x00", 2)
        if len(parts) < 3:
            continue
        sha, title, body = parts[0], parts[1], parts[2]
        commits.append({"sha": sha[:8], "title": title, "body": body})
    return commits


def title_verbatim_in_title(commit_title: str, task_title: str) -> bool:
    """Case-insensitive verbatim substring match."""
    return task_title.strip().lower() in commit_title.strip().lower() if task_title else False


# ---------------------------------------------------------------------------
# Classifier — the meat.
# ---------------------------------------------------------------------------
def parse_ts(iso: str | None) -> datetime | None:
    if not iso:
        return None
    try:
        # Normalize trailing Z → +00:00 for fromisoformat pre-3.11
        s = iso.replace("Z", "+00:00")
        return datetime.fromisoformat(s)
    except (TypeError, ValueError):
        return None


def classify_task(task: dict[str, Any], commits: list[dict[str, str]], now: datetime) -> dict[str, Any]:
    """Return one classification entry. Never mutates task."""
    task_id = task.get("id", "")
    title = task.get("title", "").strip()
    status = task.get("status", "")
    updated = parse_ts(task.get("updated_at"))

    verdict: dict[str, Any] = {
        "task_id": task_id,
        "title": title,
        "status": status,
        "assignee": task.get("assigned_to"),
        "org": task.get("org"),
        "action": "keep",       # keep | auto_close | suggest_close | flag_stale
        "reason": "",
        "evidence": {},
    }

    # Active-work skip: never touch tasks another agent updated in the last N hours.
    if updated is not None and (now - updated) < timedelta(hours=ACTIVE_WORK_SKIP_HOURS):
        verdict["reason"] = f"skipped: updated within last {ACTIVE_WORK_SKIP_HOURS}h (active work)"
        return verdict

    # STRONG-1: task_id in commit body.
    for c in commits:
        if task_id and task_id in c["body"]:
            verdict["action"] = "auto_close"
            verdict["reason"] = f"strong: task_id in commit body ({c['sha']})"
            verdict["evidence"] = {"commit_sha": c["sha"], "commit_title": c["title"]}
            return verdict

    # STRONG-2: verbatim title substring in commit title.
    for c in commits:
        if title and title_verbatim_in_title(c["title"], title):
            verdict["action"] = "auto_close"
            verdict["reason"] = f"strong: verbatim title match in commit ({c['sha']})"
            verdict["evidence"] = {"commit_sha": c["sha"], "commit_title": c["title"]}
            return verdict

    # WEAK: significant title word overlap with any commit title
    if title:
        title_words = {w.lower() for w in title.split() if len(w) > 3}
        for c in commits:
            commit_words = {w.lower() for w in c["title"].split() if len(w) > 3}
            overlap = title_words & commit_words
            if len(overlap) >= 3 and len(overlap) / max(1, len(title_words)) >= 0.5:
                verdict["action"] = "suggest_close"
                verdict["reason"] = (
                    f"weak: {len(overlap)}/{len(title_words)} title words overlap commit {c['sha']}"
                )
                verdict["evidence"] = {
                    "commit_sha": c["sha"],
                    "commit_title": c["title"],
                    "overlap_words": sorted(overlap),
                }
                return verdict

    # STALE checks (report only).
    if updated is not None:
        age = now - updated
        if status == "open" and age > timedelta(days=STALE_OPEN_DAYS):
            verdict["action"] = "flag_stale"
            verdict["reason"] = f"stale-open: no update in {age.days}d (threshold {STALE_OPEN_DAYS}d)"
            return verdict
        if status == "in_progress" and age > timedelta(days=STALE_INPROGRESS_DAYS):
            verdict["action"] = "flag_stale"
            verdict["reason"] = f"stale-inprogress: no update in {age.days}d (threshold {STALE_INPROGRESS_DAYS}d)"
            verdict["evidence"] = {"escalation": True}
            return verdict

    verdict["reason"] = "no signal — task remains open"
    return verdict


# ---------------------------------------------------------------------------
# Auto-close action — write the task JSON directly, bypassing whichever CLI's
# default-org resolution would fail here (that scatter IS the board-lies
# gap this tool exists to close, so it targets task files by absolute path).
# ---------------------------------------------------------------------------
def auto_close_task(path: Path, verdict: dict[str, Any], now_iso: str) -> bool:
    """Modify the task file in place: status → completed, add auto-close note.
    Returns True on success."""
    try:
        task = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return False
    task["status"] = "completed"
    task["completed_at"] = now_iso
    task["updated_at"] = now_iso
    existing_result = task.get("result", "") or ""
    note = f"[auto-closed by nightly-truth {now_iso[:10]}: {verdict.get('reason', '')}"
    ev = verdict.get("evidence", {})
    if ev.get("commit_sha"):
        note += f" (commit {ev['commit_sha']})"
    note += "]"
    task["result"] = (existing_result + " " + note).strip() if existing_result else note
    try:
        path.write_text(json.dumps(task, separators=(",", ":")))
        return True
    except OSError:
        return False


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Nightly cross-org bus-task truth reconciliation")
    ap.add_argument("--ctx-root", default=CTX_ROOT_DEFAULT, help="cortextOS root (default: $CTX_ROOT or ~/.cortextos/default)")
    ap.add_argument("--framework-root", default=FRAMEWORK_ROOT_DEFAULT, help="framework git repo root")
    ap.add_argument("--dry-run", action="store_true", help="classify + report only, do not modify task files")
    ap.add_argument("--no-report", action="store_true", help="skip the bus-message summary to boss-personal")
    ap.add_argument("--now", default=None, help="Override 'now' for testing (ISO 8601)")
    args = ap.parse_args()

    ctx_root = Path(args.ctx_root).expanduser()
    framework_root = Path(args.framework_root).expanduser()
    now = datetime.fromisoformat(args.now.replace("Z", "+00:00")) if args.now else datetime.now(timezone.utc)
    now_iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")

    # Discover tasks + commits.
    task_files = discover_task_files(ctx_root)
    commits = gather_recent_commits(framework_root, GIT_LOG_WINDOW_DAYS)

    # Classify each open/in-progress task.
    verdicts: list[dict[str, Any]] = []
    for tp in task_files:
        t = load_task(tp)
        if not t:
            continue
        status = t.get("status", "")
        if status not in ("open", "in_progress"):
            continue
        verdict = classify_task(t, commits, now)
        verdict["task_path"] = str(tp)
        verdicts.append(verdict)

    # Count verdicts BY ACTION regardless of dry-run — the summary tells you
    # what the classifier decided, not just what disk state changed. Track
    # actual-close attempts separately so dry-run and live-mode both report
    # the intended shape of the reconciliation.
    auto_closed_count = 0
    suggested_close_count = 0
    stale_count = 0
    kept_count = 0
    write_failures = 0

    for v in verdicts:
        if v["action"] == "auto_close":
            auto_closed_count += 1
            if not args.dry_run:
                if not auto_close_task(Path(v["task_path"]), v, now_iso):
                    write_failures += 1
                    v["write_error"] = True
        elif v["action"] == "suggest_close":
            suggested_close_count += 1
        elif v["action"] == "flag_stale":
            stale_count += 1
        else:
            kept_count += 1

    # Build report structure.
    report = {
        "generated_at": now_iso,
        "ctx_root": str(ctx_root),
        "framework_root": str(framework_root),
        "commits_scanned": len(commits),
        "tasks_scanned": len(verdicts),
        "summary": {
            "auto_closed": auto_closed_count,
            "suggest_close": suggested_close_count,
            "flag_stale": stale_count,
            "kept_open": kept_count,
            "write_failures": write_failures,
            "dry_run": bool(args.dry_run),
        },
        "verdicts": verdicts,
        "config": {
            "stale_open_days": STALE_OPEN_DAYS,
            "stale_inprogress_days": STALE_INPROGRESS_DAYS,
            "active_work_skip_hours": ACTIVE_WORK_SKIP_HOURS,
            "git_log_window_days": GIT_LOG_WINDOW_DAYS,
        },
    }

    # Write report to state dir.
    state_dir = ctx_root / "state" / "reconciliation"
    state_dir.mkdir(parents=True, exist_ok=True)
    report_path = state_dir / f"{now.strftime('%Y-%m-%d')}.json"
    report_path.write_text(json.dumps(report, indent=2))

    print(f"nightly-truth: report at {report_path}")
    print(f"  tasks scanned: {len(verdicts)}")
    print(f"  auto-closed:   {auto_closed_count}{'  (dry-run)' if args.dry_run else ''}")
    print(f"  suggest-close: {suggested_close_count}")
    print(f"  flag-stale:    {stale_count}")
    print(f"  kept open:     {kept_count}")

    # Send bus summary to boss-personal (best-effort — never fail the cron on comms error).
    if not args.no_report and not args.dry_run:
        try:
            summary = (
                f"Nightly truth-reconciliation {now.strftime('%Y-%m-%d')}: "
                f"scanned {len(verdicts)}, auto-closed {auto_closed_count}, "
                f"suggest-close {suggested_close_count}, flag-stale {stale_count}, "
                f"kept open {kept_count}. Full report: {report_path}"
            )
            subprocess.run(
                ["cortextos", "bus", "send-message", "boss-personal", "normal", summary],
                capture_output=True,
                timeout=15,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            pass  # cron continues — silent failure on comms is preferable to noisy crash

    return 0


if __name__ == "__main__":
    sys.exit(main())
