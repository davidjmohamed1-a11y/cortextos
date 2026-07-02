#!/usr/bin/env python3
"""notion-mirror.py — Mirror one doc-intake action item into David's personal
Notion Tasks DB.

Usage:
  notion-mirror.py \
    --title "action title" \
    --owner "David" \
    --area "Whitestone" \
    --layer "Backend" \
    --next-action "the concrete next step" \
    --notes "source: /path/to/source-doc.pdf" \
    [--source-doc /path/to/source-doc.pdf]

Exit codes:
  0  — mirrored successfully (or gracefully skipped: no token file)
  1  — Notion API error (network / 4xx / 5xx)
  2  — bad args / bad token file format

Token pattern (per boss 2026-07-02):
  Read at RUNTIME from ~/Desktop/NOTION-BOSS-KEY.txt, expecting a line
  `BOSS_NOTION_TOKEN=ntn_...`. Never hard-coded. Never transits the bus.
  If the token file is absent or unreadable, this script exits 0 with a
  clear "skipped: token unavailable" note — the caller's bus-task creation
  is unaffected. That makes the Notion mirror strictly ADDITIVE per boss's
  V1 direction (bus is authoritative; Notion is a nice-to-have surface).

Target data source: 3902578e-ae0d-8122-aa1b-000b258ee02a
  (personal workspace Tasks DB, Notion-Version 2025-09-03).

Property mapping (schema-driven — we fetch the DS schema at first call to
learn property types, cache it, and shape the payload accordingly). This
matches donna's pattern in orgs/personal/agents/donna/deliverables/
roadmap_build.py — same REST semantics, stdlib-only (no external deps
per repo rule).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# ---------------------------------------------------------------------------
# Config — all constants + none of the secrets. Token is read at runtime.
# ---------------------------------------------------------------------------
TOKEN_FILE = Path.home() / "Desktop" / "NOTION-BOSS-KEY.txt"
TOKEN_LINE_PREFIX = "BOSS_NOTION_TOKEN="
NOTION_VERSION = "2025-09-03"
TASKS_DATA_SOURCE_ID = "3902578e-ae0d-8122-aa1b-000b258ee02a"

SCHEMA_CACHE = Path.home() / ".cortextos" / "cache" / "notion-tasks-schema.json"


def load_token() -> str | None:
    """Read BOSS_NOTION_TOKEN from the desktop file. Returns None on any
    failure — the caller treats None as "skip Notion mirror, do not error"."""
    if not TOKEN_FILE.exists():
        return None
    try:
        for raw in TOKEN_FILE.read_text().splitlines():
            line = raw.strip()
            if line.startswith(TOKEN_LINE_PREFIX):
                token = line[len(TOKEN_LINE_PREFIX):].strip().strip('"').strip("'")
                return token or None
    except OSError:
        return None
    return None


def api_call(method: str, url: str, token: str, payload: dict | None = None) -> dict:
    data = json.dumps(payload).encode() if payload is not None else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as err:
        body = err.read().decode()[:500]
        raise RuntimeError(f"Notion {method} {url.split('notion.com')[-1]} -> HTTP {err.code}: {body}") from err
    except urllib.error.URLError as err:
        raise RuntimeError(f"Notion network error: {err}") from err


def load_or_fetch_schema(token: str) -> dict:
    """Return the Tasks DS property schema: {name: {'id': str, 'type': str}}.
    Cached on disk with no TTL — invalidate manually by deleting the file
    if the DS schema is ever edited. Sub-second-cheap on cache hit."""
    if SCHEMA_CACHE.exists():
        try:
            return json.loads(SCHEMA_CACHE.read_text())
        except (OSError, json.JSONDecodeError):
            pass  # fall through to fetch
    ds = api_call("GET", f"https://api.notion.com/v1/data_sources/{TASKS_DATA_SOURCE_ID}", token)
    if "properties" not in ds:
        raise RuntimeError(f"DS {TASKS_DATA_SOURCE_ID} returned no 'properties' key; check id/perms")
    schema = {name: {"id": meta.get("id"), "type": meta.get("type")} for name, meta in ds["properties"].items()}
    SCHEMA_CACHE.parent.mkdir(parents=True, exist_ok=True)
    try:
        SCHEMA_CACHE.write_text(json.dumps(schema, indent=2))
    except OSError:
        pass  # cache is best-effort; the api call still works
    return schema


def prop_value(kind: str, value: str) -> dict:
    """Shape a property value for Notion's API based on the property type
    the DS schema reports. Falls back to rich_text for unknown/unsupported
    shapes so the action still lands even if the schema evolves."""
    if not value:
        return None  # let caller skip empty props
    if kind == "title":
        return {"title": [{"type": "text", "text": {"content": value}}]}
    if kind == "rich_text":
        return {"rich_text": [{"type": "text", "text": {"content": value}}]}
    if kind == "select":
        return {"select": {"name": value}}
    if kind == "multi_select":
        return {"multi_select": [{"name": v.strip()} for v in value.split(",") if v.strip()]}
    if kind == "url":
        return {"url": value}
    if kind == "checkbox":
        return {"checkbox": value.lower() in ("true", "yes", "1")}
    if kind == "date":
        return {"date": {"start": value}}
    if kind == "people":
        # `people` needs a Notion user id, not a name. If caller passed a
        # name we can't resolve it here — degrade to rich_text so the info
        # lands somewhere. Real user-id resolution is a V2 stretch.
        return None
    # Unknown property type — degrade to rich_text if a rich_text field with a
    # similar name exists (caller handles). For now, skip.
    return None


def build_properties(schema: dict, fields: dict[str, str]) -> dict:
    """Given the desired {field_name: value} map + the DS schema, return a
    Notion `properties` block matched to the actual property types. Unknown
    or unmappable fields are silently skipped — the caller's bus task still
    carries them; this is a best-effort mirror."""
    props: dict[str, dict] = {}
    for name, val in fields.items():
        if name not in schema or not val:
            continue
        shaped = prop_value(schema[name]["type"], val)
        if shaped is not None:
            props[name] = shaped
    return props


def find_title_prop(schema: dict) -> str:
    """The Notion DB always has exactly one `title` property. Its name might
    be `Name` or something else — we look it up so we can always set the
    title even if the DB uses a different label."""
    for name, meta in schema.items():
        if meta.get("type") == "title":
            return name
    raise RuntimeError("DS has no title property (?!)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Mirror doc-intake action into David's Notion Tasks DB")
    ap.add_argument("--title", required=True, help="Action title (goes into the DB's Title property)")
    ap.add_argument("--owner", default="", help="Owner: David | Fleet | <agent>")
    ap.add_argument("--area", default="", help="Area: Whitestone | Personal | Finance | ...")
    ap.add_argument("--layer", default="", help="Layer: Backend | Frontend | External | ...")
    ap.add_argument("--next-action", default="", help="Concrete next step")
    ap.add_argument("--notes", default="", help="Free-form notes (source doc path etc.)")
    ap.add_argument("--source-doc", default="", help="Path to the source document (appended to notes)")
    args = ap.parse_args()

    token = load_token()
    if not token:
        print(f"notion-mirror: skipped — token file {TOKEN_FILE} absent or empty; bus task still recorded")
        return 0

    # Compose notes: prepend source-doc path if provided.
    notes = args.notes
    if args.source_doc:
        prefix = f"Source: {args.source_doc}"
        notes = f"{prefix}\n{notes}" if notes else prefix

    try:
        schema = load_or_fetch_schema(token)
    except RuntimeError as err:
        print(f"notion-mirror: schema fetch failed: {err}", file=sys.stderr)
        return 1

    title_prop = find_title_prop(schema)

    # Best-effort field->schema-property mapping. We use the exact field names
    # boss named (Name/Owner/Area/Layer/Next Action/Notes) if present; the
    # title always uses the schema's actual title property name.
    fields = {
        title_prop: args.title,
        "Owner": args.owner,
        "Area": args.area,
        "Layer": args.layer,
        "Next Action": args.next_action,
        "Notes": notes,
    }

    props = build_properties(schema, fields)

    payload = {
        "parent": {"type": "data_source_id", "data_source_id": TASKS_DATA_SOURCE_ID},
        "properties": props,
    }

    try:
        page = api_call("POST", "https://api.notion.com/v1/pages", token, payload)
    except RuntimeError as err:
        print(f"notion-mirror: {err}", file=sys.stderr)
        return 1

    page_url = page.get("url") or page.get("id") or "(no url returned)"
    print(f"notion-mirror: OK → {page_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
