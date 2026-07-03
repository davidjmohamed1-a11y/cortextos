#!/usr/bin/env python3
"""nightly-consolidator.py — Per-agent sleep-time consolidation.

Runs in the nighttime window (currently wasted): re-reads yesterday's REAL
record (comms archive JSONL + task results + daily memory) and writes:

  1. Small itemized additions to <agent>/MEMORY.md — ACE-strict:
     - NEVER touches existing lines (dedup only; no summarize / rewrite)
     - Cap at MAX_LINES_PER_NIGHT new lines/night (default 5)
     - Each line dated + attributed inline
     - The file's TOP-LEVEL source: agent-reasoning frontmatter (already
       retro-tagged fleet-wide 2026-07-02) satisfies the memory-provenance
       hard rule for the whole file; appended lines inherit that provenance

  2. Pre-computed morning brief at
     <ctxRoot>/state/morning-brief/<agent>/<YYYY-MM-DD>.md
     — the agent reads this at session start / heartbeat instead of walking
       comms archive + tasks live. 1 file read, ~50 lines.

Extraction is MECHANICAL (regex + heuristic + dedup) — no LLM synthesis.
Real semantic reads happen agent-side when they read the brief tomorrow.
Boss decision 2026-07-02: mechanical is more faithful for V1.

Ship: 2026-07-02 (per boss GO, Fable-audit follow-on / roadmap #1).
Stdlib-only (matches repo rule: no new runtime deps).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
CTX_ROOT_DEFAULT = os.environ.get("CTX_ROOT", str(Path.home() / ".cortextos" / "default"))
FRAMEWORK_ROOT_DEFAULT = os.environ.get(
    "CTX_FRAMEWORK_ROOT",
    str(Path.home() / "cortextos"),
)
MAX_LINES_PER_NIGHT = int(os.environ.get("CONSOLIDATOR_CAP", "5"))
DEDUP_MIN_LEN = 15  # short strings dedup poorly; require this many chars for the check

# Signal weights (tunable via env for iteration)
WEIGHT_EXPLICIT_PREF = int(os.environ.get("CONSOLIDATOR_W_PREF", "3"))
WEIGHT_CORRECTION = int(os.environ.get("CONSOLIDATOR_W_CORRECTION", "2"))
WEIGHT_TASK_COMPLETION = int(os.environ.get("CONSOLIDATOR_W_TASK", "2"))
WEIGHT_REPEAT_TOPIC = int(os.environ.get("CONSOLIDATOR_W_REPEAT", "1"))

# Regex patterns used for extraction (case-insensitive)
PREF_RE = re.compile(
    r"\b(from now on|going forward|always\s+\w|never\s+\w|my preference|"
    r"do NOT|do not|prefer\s+\w|instead of|the rule is|from here on)\b",
    re.IGNORECASE,
)
CORRECTION_RE = re.compile(
    r"\b(caught|flagged|wrong call|mistake|regression|lesson|no—|no,\s+that|"
    r"actually,?\s+the|correction:)\b",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Date + path helpers
# ---------------------------------------------------------------------------
def utc_date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%d")


def target_slice_dates(now: datetime) -> list[str]:
    """Return the list of dates we consolidate FROM tonight.

    Default = yesterday only. Sunday nights (Sun local = day 6 in Python's
    weekday()) consolidate Fri+Sat+Sun (weekend grace, boss default). This
    is "Sun-only weekend grace" per plan.

    Boundary: 'now' is the moment the cron fires (nighttime, so already
    the *next* day in UTC terms depending on tz). Anchor off calendar-day
    subtraction from now-1d as the "primary yesterday", then look back
    over up to 3 days on Sunday.
    """
    y = now - timedelta(days=1)
    if y.weekday() == 6:  # Sunday
        return [utc_date(y - timedelta(days=n)) for n in range(3)]
    return [utc_date(y)]


def comms_archive_file(ctx_root: Path, agent: str, date: str) -> Path:
    yyyymm = date[:7]
    return ctx_root / "analytics" / "comms" / yyyymm / f"{agent}.jsonl"


def memory_file(framework_root: Path, org: str, agent: str) -> Path:
    return framework_root / "orgs" / org / "agents" / agent / "MEMORY.md"


def daily_memory_file(framework_root: Path, org: str, agent: str, date: str) -> Path:
    return framework_root / "orgs" / org / "agents" / agent / "memory" / f"{date}.md"


def tasks_dir(ctx_root: Path, org: str) -> Path:
    return ctx_root / "orgs" / org / "tasks"


def morning_brief_file(ctx_root: Path, agent: str, for_date: str) -> Path:
    return ctx_root / "state" / "morning-brief" / agent / f"{for_date}.md"


# ---------------------------------------------------------------------------
# Data loaders
# ---------------------------------------------------------------------------
def load_comms_for_dates(ctx_root: Path, agent: str, dates: list[str]) -> list[dict[str, Any]]:
    """Read comms archive JSONL entries whose timestamp falls in `dates`."""
    out: list[dict[str, Any]] = []
    files = {comms_archive_file(ctx_root, agent, d) for d in dates}
    for f in files:
        if not f.exists():
            continue
        try:
            for line in f.read_text().splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                ts = entry.get("timestamp", "")[:10]
                if ts in dates:
                    out.append(entry)
        except OSError:
            continue
    return out


def load_tasks_for_agent(
    ctx_root: Path, org: str, agent: str, dates: list[str]
) -> list[dict[str, Any]]:
    """Return tasks completed by the agent in the target window. Includes
    human-task completions (assigned_to=human/user) per boss's Rec-3."""
    out: list[dict[str, Any]] = []
    d = tasks_dir(ctx_root, org)
    if not d.exists():
        return out
    for p in d.iterdir():
        if not p.name.startswith("task_") or p.suffix != ".json":
            continue
        try:
            t = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        completed = (t.get("completed_at") or "")[:10]
        if completed not in dates:
            continue
        assignee = t.get("assigned_to") or ""
        # Include tasks completed BY this agent OR by human (David) — humans
        # completing tasks is the strongest learning signal (per boss).
        if assignee == agent or assignee in ("human", "user", "david"):
            out.append(t)
    return out


def load_daily_memory(framework_root: Path, org: str, agent: str, dates: list[str]) -> str:
    """Concatenate daily memory files for the target dates."""
    parts = []
    for d in dates:
        p = daily_memory_file(framework_root, org, agent, d)
        if p.exists():
            try:
                parts.append(p.read_text())
            except OSError:
                continue
    return "\n\n".join(parts)


def load_existing_memory_lines(mem_path: Path) -> list[str]:
    """Read MEMORY.md as a set of stripped, normalized lines for dedup use."""
    if not mem_path.exists():
        return []
    try:
        raw = mem_path.read_text()
    except OSError:
        return []
    # Strip the frontmatter block if present.
    body = re.sub(r"^\s*---[\s\S]*?---\s*", "", raw, count=1)
    return [ln.strip() for ln in body.splitlines() if ln.strip()]


# ---------------------------------------------------------------------------
# Extraction — mechanical, no LLM
# ---------------------------------------------------------------------------
def normalize_for_dedup(s: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace — used only for
    substring matching against existing MEMORY.md lines."""
    return re.sub(r"\s+", " ", re.sub(r"[^\w\s]", " ", s.lower())).strip()


def extract_preferences(comms: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """Inbound comms containing an explicit-preference marker → candidate."""
    out: list[tuple[str, int]] = []
    for c in comms:
        if c.get("direction") != "inbound":
            continue
        text = (c.get("text") or "").strip()
        if not text or len(text) < DEDUP_MIN_LEN:
            continue
        m = PREF_RE.search(text)
        if not m:
            continue
        # Extract the sentence containing the match — cheap slice around the marker.
        start, end = m.span()
        left = max(0, text.rfind(".", 0, start) + 1)
        right = text.find(".", end)
        right = len(text) if right == -1 else right + 1
        snippet = text[left:right].strip()
        # Clip long snippets for MEMORY.md hygiene.
        if len(snippet) > 220:
            snippet = snippet[:217].rstrip() + "…"
        out.append((snippet, WEIGHT_EXPLICIT_PREF))
    return out


def extract_corrections(comms: list[dict[str, Any]], daily_mem: str) -> list[tuple[str, int]]:
    """Correction/mistake markers → candidate."""
    out: list[tuple[str, int]] = []
    sources = [c.get("text", "") for c in comms if c.get("direction") == "inbound"]
    sources.append(daily_mem)
    for text in sources:
        text = (text or "").strip()
        if not text:
            continue
        for m in CORRECTION_RE.finditer(text):
            start, end = m.span()
            left = max(0, text.rfind(".", 0, start) + 1)
            right = text.find(".", end)
            right = len(text) if right == -1 else right + 1
            snippet = text[left:right].strip()
            if len(snippet) < DEDUP_MIN_LEN:
                continue
            if len(snippet) > 220:
                snippet = snippet[:217].rstrip() + "…"
            out.append((snippet, WEIGHT_CORRECTION))
    return out


def extract_task_completions(tasks: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """Task completions with results → candidate."""
    out: list[tuple[str, int]] = []
    for t in tasks:
        title = (t.get("title") or "").strip()
        result = (t.get("result") or "").strip()
        if not title:
            continue
        # Look for commit SHA in result (any git-hash-shaped token).
        sha_m = re.search(r"\b([0-9a-f]{7,40})\b", result)
        commit_note = f" (commit {sha_m.group(1)[:7]})" if sha_m else ""
        line = f"{title}{commit_note}"
        # Cap length
        if len(line) > 220:
            line = line[:217].rstrip() + "…"
        out.append((line, WEIGHT_TASK_COMPLETION))
    return out


def extract_repeat_topics(comms: list[dict[str, Any]], tasks: list[dict[str, Any]]) -> list[tuple[str, int]]:
    """Bigrams appearing across >=3 comms AND >=1 task → candidate. Weakest
    signal — used sparingly."""
    STOP = {
        "the", "and", "for", "with", "that", "this", "have", "has", "you", "your",
        "our", "all", "not", "but", "are", "was", "were", "will", "would", "should",
        "any", "one", "two", "just", "from", "into", "onto", "over", "very", "much",
        "more", "most", "some", "then", "than", "when", "which", "what", "how", "who",
        "boss", "personal", "cortextos", "forge", "atlas", "donna", "kai", "nova",
        "pam", "alfred", "oracle", "get", "got", "make", "made", "run", "runs", "ran",
        "also", "already", "before", "after", "here", "there", "back", "still",
    }

    def tokens(text: str) -> list[str]:
        return [w.lower() for w in re.findall(r"[a-zA-Z]{4,}", text or "") if w.lower() not in STOP]

    bigrams: Counter[str] = Counter()
    for c in comms:
        toks = tokens(c.get("text") or "")
        for a, b in zip(toks, toks[1:]):
            bigrams[f"{a} {b}"] += 1
    task_text = " ".join(t.get("title", "") + " " + t.get("description", "") for t in tasks)
    task_toks = set(tokens(task_text))

    out: list[tuple[str, int]] = []
    for bg, cnt in bigrams.most_common(20):
        if cnt < 3:
            continue
        # Bigram must have >=1 word overlap with task text — anchors to real work
        if not (set(bg.split()) & task_toks):
            continue
        out.append((f"Repeat topic across {cnt} comms: '{bg}'", WEIGHT_REPEAT_TOPIC))
    return out


# ---------------------------------------------------------------------------
# Dedup + cap + append
# ---------------------------------------------------------------------------
def dedup_against_existing(
    candidates: list[tuple[str, int]], existing_lines: list[str]
) -> list[tuple[str, int]]:
    """Drop candidates whose normalized form is a substring of any existing
    MEMORY.md line (or vice-versa). Substring-match works well for short-
    itemized additions where a re-phrasing still overlaps."""
    existing_norms = [normalize_for_dedup(ln) for ln in existing_lines]
    kept: list[tuple[str, int]] = []
    seen_norms: set[str] = set()
    for text, weight in candidates:
        norm = normalize_for_dedup(text)
        if not norm or len(norm) < DEDUP_MIN_LEN:
            continue
        if any(norm in en or en in norm for en in existing_norms):
            continue
        # Also dedup within THIS batch.
        if any(norm in sn or sn in norm for sn in seen_norms):
            continue
        seen_norms.add(norm)
        kept.append((text, weight))
    return kept


def take_top_n(candidates: list[tuple[str, int]], n: int) -> list[tuple[str, int]]:
    """Sort by weight desc + preserve original insertion order for ties."""
    indexed = [(i, text, w) for i, (text, w) in enumerate(candidates)]
    indexed.sort(key=lambda t: (-t[2], t[0]))
    return [(text, w) for _, text, w in indexed[:n]]


def append_to_memory(mem_path: Path, additions: list[tuple[str, int]], date: str) -> None:
    """Literal append to MEMORY.md. No touch of existing content."""
    if not additions:
        return
    mem_path.parent.mkdir(parents=True, exist_ok=True)
    if not mem_path.exists():
        # Bootstrap with the frontmatter to satisfy the provenance rule.
        mem_path.write_text("---\nsource: agent-reasoning\n---\n\n")

    lines = ["\n"]
    for text, _weight in additions:
        # One-line normalization: collapse internal newlines.
        one_line = re.sub(r"\s+", " ", text).strip()
        lines.append(f"- [{date} by:nightly-consolidator] {one_line}\n")

    with mem_path.open("a", encoding="utf-8") as f:
        f.write("".join(lines))


# ---------------------------------------------------------------------------
# Morning-brief writer
# ---------------------------------------------------------------------------
def build_morning_brief(
    agent: str,
    for_date: str,
    dates_consolidated: list[str],
    comms: list[dict[str, Any]],
    tasks: list[dict[str, Any]],
    additions: list[tuple[str, int]],
    inflight_tasks: list[dict[str, Any]],
) -> str:
    inbound = [c for c in comms if c.get("direction") == "inbound"]
    outbound = [c for c in comms if c.get("direction") == "outbound"]
    telegram = [c for c in comms if c.get("channel") == "telegram"]

    last_inbound_from = "(none)"
    last_inbound_text = ""
    if inbound:
        last = max(inbound, key=lambda c: c.get("timestamp", ""))
        last_inbound_from = last.get("sender", "?")
        last_inbound_text = (last.get("text") or "").split("\n")[0][:140]

    open_tasks_titles = [t.get("title", "")[:90] for t in inflight_tasks[:5]]
    blocked_tasks = [t for t in inflight_tasks if t.get("status") == "blocked"]

    lines: list[str] = []
    lines.append("---")
    lines.append("source: agent-reasoning")
    lines.append(f"generated_at: {datetime.now(timezone.utc).isoformat()}")
    lines.append("by: nightly-consolidator")
    lines.append(f"for_date: {for_date}")
    lines.append(f"consolidated_dates: {', '.join(dates_consolidated)}")
    lines.append("---\n")

    lines.append(f"# Morning brief for {agent} — {for_date}\n")

    lines.append("## Yesterday recap")
    lines.append(f"- Comms: {len(inbound)} inbound / {len(outbound)} outbound / {len(telegram)} on Telegram")
    lines.append(f"- Tasks completed: {len(tasks)}\n")

    lines.append("## End-of-day focus")
    lines.append(f"- Last inbound from: {last_inbound_from}")
    if last_inbound_text:
        lines.append(f"  > {last_inbound_text}")
    lines.append("")

    lines.append("## Open threads (in_progress + blocked)")
    if open_tasks_titles:
        for t in open_tasks_titles:
            lines.append(f"- {t}")
    else:
        lines.append("- (no in-flight tasks)")
    lines.append("")

    lines.append("## Waiting on")
    if blocked_tasks:
        for t in blocked_tasks[:3]:
            lines.append(f"- BLOCKED: {t.get('title', '')[:90]}")
    else:
        lines.append("- (nothing blocked)")
    lines.append("")

    lines.append("## New learnings persisted to MEMORY.md last night")
    if additions:
        for text, _w in additions:
            one_line = re.sub(r"\s+", " ", text).strip()
            lines.append(f"- {one_line}")
    else:
        lines.append("- (quiet night — no new additions)")
    lines.append("")

    lines.append("## Suggested next")
    if inflight_tasks:
        top = inflight_tasks[0]
        lines.append(f"- {top.get('title', '')[:120]}")
    elif open_tasks_titles:
        lines.append(f"- {open_tasks_titles[0]}")
    else:
        lines.append("- (no obvious next — check inbox + boss's morning dispatch)")
    lines.append("")

    return "\n".join(lines) + "\n"


def load_inflight_tasks(ctx_root: Path, org: str, agent: str) -> list[dict[str, Any]]:
    """Tasks currently in_progress or blocked assigned to this agent."""
    out: list[dict[str, Any]] = []
    d = tasks_dir(ctx_root, org)
    if not d.exists():
        return out
    for p in d.iterdir():
        if not p.name.startswith("task_") or p.suffix != ".json":
            continue
        try:
            t = json.loads(p.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        status = t.get("status", "")
        if status in ("in_progress", "blocked", "open", "pending"):
            if t.get("assigned_to") == agent:
                out.append(t)
    # Sort by priority
    pri = {"critical": 0, "urgent": 1, "high": 2, "normal": 3, "low": 4}
    out.sort(key=lambda t: pri.get(t.get("priority", "normal"), 3))
    return out


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main() -> int:
    ap = argparse.ArgumentParser(description="Nightly per-agent sleep-time consolidation")
    ap.add_argument("--agent", required=True, help="Agent name (e.g. forge, atlas)")
    ap.add_argument("--org", default="personal", help="Org name (default: personal)")
    ap.add_argument("--ctx-root", default=CTX_ROOT_DEFAULT)
    ap.add_argument("--framework-root", default=FRAMEWORK_ROOT_DEFAULT)
    ap.add_argument("--now", default=None, help="Override 'now' for testing (ISO 8601)")
    ap.add_argument("--dry-run", action="store_true", help="Extract + report, do NOT write MEMORY.md or brief")
    ap.add_argument("--cap", type=int, default=MAX_LINES_PER_NIGHT, help="Max new lines per night")
    args = ap.parse_args()

    ctx_root = Path(args.ctx_root).expanduser()
    framework_root = Path(args.framework_root).expanduser()
    now = (
        datetime.fromisoformat(args.now.replace("Z", "+00:00"))
        if args.now
        else datetime.now(timezone.utc)
    )
    dates = target_slice_dates(now)
    for_date = utc_date(now)  # brief is FOR today (the agent reads it this morning)

    comms = load_comms_for_dates(ctx_root, args.agent, dates)
    tasks = load_tasks_for_agent(ctx_root, args.org, args.agent, dates)
    daily_mem = load_daily_memory(framework_root, args.org, args.agent, dates)

    # Extract candidates.
    candidates: list[tuple[str, int]] = []
    candidates += extract_preferences(comms)
    candidates += extract_corrections(comms, daily_mem)
    candidates += extract_task_completions(tasks)
    candidates += extract_repeat_topics(comms, tasks)

    # Dedup against existing MEMORY.md.
    mem_path = memory_file(framework_root, args.org, args.agent)
    existing_lines = load_existing_memory_lines(mem_path)
    deduped = dedup_against_existing(candidates, existing_lines)

    # Cap.
    additions = take_top_n(deduped, args.cap)

    # Append (unless dry-run).
    if not args.dry_run and additions:
        append_to_memory(mem_path, additions, for_date)

    # Build + write morning brief.
    inflight = load_inflight_tasks(ctx_root, args.org, args.agent)
    brief = build_morning_brief(
        args.agent, for_date, dates, comms, tasks, additions, inflight
    )
    brief_path = morning_brief_file(ctx_root, args.agent, for_date)
    if not args.dry_run:
        brief_path.parent.mkdir(parents=True, exist_ok=True)
        brief_path.write_text(brief)

    # Human-readable summary line.
    print(
        f"nightly-consolidator {args.agent}: consolidated {len(dates)}d"
        f" ({', '.join(dates)}), candidates={len(candidates)}, deduped={len(deduped)},"
        f" appended={len(additions)}"
        + ("  (dry-run)" if args.dry_run else "")
    )
    print(f"  brief: {brief_path}")
    print(f"  memory: {mem_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
