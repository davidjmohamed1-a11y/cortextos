---
name: document-intake
description: "David dropped documents (PDFs, Word, RTF, TXT, MD) in his inbox folder, OR sent a document via Telegram — extract the text, surface any action items as tracked tasks (via the bus), then move the file to processed/. You should invoke this any time you see a new file in ~/Whitestone-Fleet/Inbox/documents/, or when a Telegram document message arrives with local_file:. This is Jarvis capture-channel 2 — same downstream as voice-transcription (text → action items → tracked tasks)."
triggers: ["document intake", "intake documents", "process docs", "process documents", "inbox folder", "documents inbox", "handle document", "extract action items", "action items from doc", "read pdf", "process pdf", "process word", "process docx", "watch inbox", "check inbox folder", "new document dropped", "action items pdf"]
---

# Document intake — Jarvis capture-channel 2

Native macOS extraction pipeline. David drops files in `~/Whitestone-Fleet/Inbox/documents/` (or sends a doc via Telegram); this skill scans, extracts text, identifies action items with your judgment, files them as tracked tasks, and archives the source.

Same downstream spine as the voice channel: **capture → text → agent inbox → tracked task**. No Notion write in V1 (stretch, waits on the Boss Notion token flow).

---

## When to run

Invoke this skill when:
- A new file appears in `~/Whitestone-Fleet/Inbox/documents/` (any format below).
- A `=== TELEGRAM DOCUMENT ===` message arrives with `local_file:` — same handler applies; treat the local_file path as the input.
- David asks you to "process the inbox" / "read what's in Whitestone-Fleet/Inbox".
- On a heartbeat cycle: quickly scan the folder for any pending files — if none, this is a no-op (do not invent work).

Do NOT invoke for:
- Files already in `processed/` (they've been intaked).
- Files hidden (leading `.`) — ignore.
- Files in `Inbox/documents/processed/*` — that's the archive.

---

## The extraction pipeline

Text is pulled by `scripts/document-intake/extract.sh` — native macOS tools only, zero external deps. Supported formats:

| Extension | How it's extracted |
|---|---|
| `.pdf` | `mdls -name kMDItemTextContent` (Spotlight-indexed text) → `PDFKit` via Swift fallback if empty |
| `.doc` `.docx` `.rtf` `.rtfd` `.html` `.htm` | `textutil -convert txt` |
| `.txt` `.md` `.markdown` `.log` `.json` `.yaml` `.yml` `.csv` `.tsv` `.xml` | direct `cat` |
| anything else | `extract.sh` exits nonzero — you skip the file + move to `processed/skipped/` (see below) |

Failure modes worth naming:
- **Image-only PDFs** (scanned, no OCR): `pdf-extract.swift` exits 3 with stderr "no extractable text". You skip these + note the reason on the skipped move.
- **Password-protected PDFs**: PDFKit exits nonzero; same treatment.
- **Corrupt files**: `extract.sh` exits 1; same treatment.

---

## The flow

Run this as a single-pass loop over the inbox contents. Each file is one loop iteration; skip nothing silently.

```bash
INBOX="$HOME/Whitestone-Fleet/Inbox/documents"
PROCESSED="$INBOX/processed/$(date +%Y-%m-%d)"
SKIPPED="$INBOX/processed/skipped/$(date +%Y-%m-%d)"
EXTRACT="$CTX_FRAMEWORK_ROOT/scripts/document-intake/extract.sh"

mkdir -p "$PROCESSED" "$SKIPPED"

# Find candidate files (top-level only; ignore hidden + already-processed subtree)
find "$INBOX" -maxdepth 1 -type f -not -name '.*' | while read -r file; do
  base="$(basename "$file")"
  text="$("$EXTRACT" "$file" 2>/dev/null)" || {
    echo "SKIP: $base (extraction failed)"
    mv "$file" "$SKIPPED/$base"
    continue
  }
  # Text is now in $text — read it, identify action items (see next section),
  # create tasks, then move source to processed/.
  # ... (see 'Reading + acting on the text' below) ...
  mv "$file" "$PROCESSED/$base"
done
```

Do NOT parallelize — one file at a time. Reading, judgment, and task creation happen inline; the next file waits.

---

## Reading + acting on the text

For each extracted document, you (the agent) read the text and do two passes:

### Pass 1 — Heuristic marker scan (cheap, always run first)

Grep for common action-item markers:
- Lines beginning with `TODO:`, `TODO ` (case-insensitive)
- Lines beginning with `Action:` / `Action Item:` / `Follow up:` / `Follow-up:` / `Next step:` / `Next Steps:`
- Numbered/bulleted lines under a heading like `Action Items`, `To Do`, `Next Steps`, `Follow-ups`
- Deadlines: lines containing `by <date>` / `due <date>` / `deadline`

Extract the actionable sentence + any relevant deadline/owner.

### Pass 2 — Interpretive pass (your judgment)

Read the full text. Identify actions that are not marker-tagged:
- Meeting recap → action items implied by "will do", "should send", "I'll follow up"
- Proposal PDF → the ask (respond by X, review the draft)
- Contract → deadlines + counter-signature required
- Email thread export → any commitment David made or received

Distinguish action items David owns vs. actions the counterparty owns. **David-owns get tasks; counterparty-owns get noted in the task description but not as separate tasks.**

If a document is pure reference/no actions (a fact sheet, an FYI briefing), record ONE task like `Read + file: <doc name>` so it stays visible on the tracker. Do not silently drop docs.

---

## Task creation

For each action item found:

```bash
cortextos bus create-task \
  "<one-line action title, verb-first>" \
  --desc "Source: $base (intaked $(date +%Y-%m-%d))
Full context: $file

<full action sentence + any deadline / owner / relevant surrounding text>"
```

Assignee: default is the invoking agent (leave off unless it obviously belongs to another agent — e.g. kai for email drafts, donna for Whitestone-ops).

If the doc has 5+ action items, create a PARENT task first with the doc name, then subtasks linked to it. Avoid task-storm.

If nothing actionable exists after both passes, log a single "read + filed" task per above.

---

## After task creation — archive the source

Move the file into `Inbox/documents/processed/<YYYY-MM-DD>/`. This keeps the top-level inbox clean and lets David audit what was intaked when.

**Do not delete the source.** David may need to re-read it.

---

## Reporting back to David

For each intake batch, after all files are processed, send David a single Telegram summary (via boss-personal → David, unless you're the boss agent yourself):

```
=== INTAKE — <YYYY-MM-DD> ===
Files processed: N
Files skipped: K (extraction failed)
Tasks created: T
Top 3 actions:
  - <highest-priority action>
  - <second>
  - <third>

Full list: cortextos bus list-tasks --status open --created-after <date>
```

If N is zero, do NOT send a report — silence is fine for an empty inbox pass.

---

## Telegram document intake

When a Telegram document message arrives:

```
=== TELEGRAM DOCUMENT from David (chat_id:5737043293) ===
caption: <caption if any>
local_file: telegram-images/document_20260702_130400.pdf
file_name: proposal.pdf
Reply using: ...
```

Treat `local_file` as the file path. Extract → find action items → create tasks. If David captioned the message, treat the caption as an override context (e.g. "urgent" → priority='high').

Reply on the same chat with a one-line intake receipt: `Intaked <file_name> — created N task(s).`

---

## Testing the pipeline

Before running on real docs, prove the extraction chain:

```bash
# TXT
echo "TODO: buy oranges" > /tmp/di-smoke.txt
scripts/document-intake/extract.sh /tmp/di-smoke.txt
# Should print: TODO: buy oranges

# PDF (use any PDF you have)
scripts/document-intake/extract.sh path/to/some.pdf
# Should print extracted text OR exit 3 (image-only PDF) with a clear stderr message

# Unsupported
touch /tmp/di-smoke.xyz
scripts/document-intake/extract.sh /tmp/di-smoke.xyz
# Should exit 1 with 'unsupported extension: .xyz'
```

---

## Failure discipline

- **Extract fails**: move to `processed/skipped/<YYYY-MM-DD>/`; note the reason in a `.reason.txt` sibling. Do NOT retry — the next scan is a fresh chance.
- **Task creation fails**: leave the source file in place (do NOT move); retry on the next scan cycle. The bus create-task path is normally reliable; a failure here means something bigger is wrong.
- **Move fails**: log + continue. The file staying in inbox is fine (next scan will re-attempt).

Never spawn infinite retry loops. One pass, one attempt per file.

---

## Files this skill touches

- Read: `~/Whitestone-Fleet/Inbox/documents/*` (top-level files)
- Read: any `local_file:` path from a Telegram document message
- Write: `~/Whitestone-Fleet/Inbox/documents/processed/<YYYY-MM-DD>/*` (archive)
- Write: `~/Whitestone-Fleet/Inbox/documents/processed/skipped/<YYYY-MM-DD>/*` (skip archive + reason)
- Write: cortextos tasks via `cortextos bus create-task`
- Read/Exec: `scripts/document-intake/extract.sh` + `scripts/document-intake/pdf-extract.swift`

---

## V2 stretch (not V1)

- Notion write path: mirror created tasks into David's personal Notion Tasks DB. Requires Boss Notion token handoff. Held until boss routes it.
- OCR for image-only PDFs (Tesseract or macOS Vision framework via a Swift helper).
- Auto-classification (proposal / contract / meeting-notes / FYI) driving task tagging.
- Slack / email inbound as capture-channel 3.
