# Google Sheets Setup (one-time)

This walks you through giving cortextOS the ability to read and edit specific Google Sheets — without installing any third-party MCP servers. Once it's set up, agents can call `cortextos bus update-sheet` to append rows, set cells, or run batch updates on the sheets you choose.

You only do this once. Plan ~20 minutes for the first time.

---

## What you're setting up, in plain English

You're creating a "service account" — a special kind of Google identity that has its own email address. You then share the specific sheets you want forge to edit with that email address, just like you'd share a sheet with a teammate.

The service account doesn't have to log in. It uses a key file (a JSON file on your laptop) to prove who it is. That key file lives in a folder that doesn't sync to the cloud or get committed to git.

**The security advantage**: the service account can only touch sheets you've explicitly shared with it. If you don't share a sheet, the service account can't see or change it. That's much narrower than letting forge into your whole Google account.

---

## Step 1 — Create or pick a Google Cloud project

If you already have a Google Cloud project (say, for any other tooling), use that. Otherwise:

1. Go to https://console.cloud.google.com/
2. Click the project dropdown at the top → **New Project**
3. Name it something memorable like "cortextos-sheets"
4. Create. Wait ~30 seconds for the project to spin up. Make sure the project dropdown now shows your new project before continuing.

---

## Step 2 — Enable the Sheets API

1. In the left sidebar: **APIs & Services → Library**
2. Search for "Google Sheets API"
3. Click it → **Enable**

That's it. The API is now enabled on this project.

---

## Step 3 — Create the service account

1. In the left sidebar: **IAM & Admin → Service Accounts**
2. Click **+ Create Service Account**
3. Name: `cortextos-sheets-writer` (or any name you'll recognize)
4. ID: auto-fills from the name (e.g., `cortextos-sheets-writer`)
5. Skip the "Grant this service account access to project" section — you don't need a project-level role for this use case. The per-sheet sharing in Step 5 is where access actually lives.
6. Skip the "Grant users access to this service account" section
7. Click **Done**

You're now back at the Service Accounts list and your new one is there. **Copy the email address** that looks like `cortextos-sheets-writer@<your-project>.iam.gserviceaccount.com` — you'll paste it into Google Sheets in Step 5.

---

## Step 4 — Download the JSON key

1. Click your new service account's email to open it
2. Tab: **Keys** → **Add Key → Create new key**
3. Key type: **JSON** → **Create**
4. A file downloads. It's named something like `cortextos-sheets-writer-abc123.json`. **Treat this file like a password.** Anyone with it can act as the service account on any sheet you've shared with it.

Move the file to a safe location:

```bash
mkdir -p /Users/davidmohamed/cortextos/orgs/personal/secrets
mv ~/Downloads/cortextos-sheets-writer-*.json /Users/davidmohamed/cortextos/orgs/personal/secrets/sheets-sa.json
chmod 600 /Users/davidmohamed/cortextos/orgs/personal/secrets/sheets-sa.json
```

The `chmod 600` makes the file readable only by you — even other accounts on your laptop can't read it.

Then tell cortextOS where to find it. Open your agent's `.env` file (for boss-personal: `orgs/personal/agents/boss-personal/.env`) and add:

```
GOOGLE_SHEETS_SA_KEY_PATH=/Users/davidmohamed/cortextos/orgs/personal/secrets/sheets-sa.json
```

If you want every agent in the org to use the same key, set it as a system environment variable instead. A per-agent .env is the simpler default.

Restart the agent so it picks up the new env:

```bash
cortextos stop boss-personal
cortextos start boss-personal
```

---

## Step 5 — Share each sheet with the service account

This is the most important step. The service account can only touch sheets you explicitly share with it.

For each sheet you want forge to be able to edit:

1. Open the sheet in Google Sheets
2. Click **Share** (top right)
3. Paste the service account email (the one from Step 3, ends in `@<project>.iam.gserviceaccount.com`)
4. Set the permission to **Editor**
5. **Uncheck "Notify people"** (the service account doesn't have an inbox)
6. Click **Share**

The service account now has Editor access to that one sheet, and only that one sheet. Repeat for any other sheets you want covered.

---

## Step 6 — Test that it works

Pick any sheet you shared. Copy its ID — it's the long string in the URL between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/THIS_IS_THE_ID/edit#gid=0
```

Then from the cortextOS directory:

```bash
# Append one row to the first tab
cortextos bus update-sheet append <sheet-id> "Sheet1!A:B" '[["test","2026-06-06"]]'

# Set a single cell
cortextos bus update-sheet set-cell <sheet-id> "Sheet1!D1" "hello from forge"
```

If it works, the command prints something like `Appended 1 row(s) → updated range Sheet1!A5:B5 (2 cells)` and the sheet updates within a second or two. Open the sheet in your browser and you'll see the change.

If something's wrong, you'll see one of:

- **"Cannot read service account key at …"** — the key file isn't where the `.env` says it is. Check the path.
- **"Google token exchange failed: Invalid grant: account not found"** — the JSON key is malformed or the service account got deleted in Google Cloud.
- **"Sheets API error: The caller does not have permission"** — you forgot to share the sheet with the service account email (Step 5), or you shared it as Viewer not Editor.
- **"Sheets API error: Requested entity was not found"** — the spreadsheet ID is wrong (typo, or the URL had extra stuff).

---

## Quick reference: the three operations

```bash
# Append rows. <values-json> is a JSON 2D array — outer = rows, inner = cells.
cortextos bus update-sheet append <sheet-id> "Sheet1!A:D" '[["a","b","c","d"],["e","f","g","h"]]'

# Set a single cell. Values are entered USER_ENTERED so "=SUM(A1:A5)" becomes a formula,
# "5" becomes a number, "text" stays text.
cortextos bus update-sheet set-cell <sheet-id> "Sheet1!B7" "hello"

# Run a raw Sheets batchUpdate. Advanced — <requests-json> is the array of request
# objects (NOT the full envelope). Pass "-" to read JSON from stdin.
cortextos bus update-sheet batch-update <sheet-id> '[{"addSheet":{"properties":{"title":"New tab"}}}]'

# Or from stdin:
echo '[{"addSheet":{"properties":{"title":"Another"}}}]' | \
  cortextos bus update-sheet batch-update <sheet-id> -
```

For the full batchUpdate request reference (every available operation — addSheet, updateCells, deleteRange, mergeCells, etc.), see Google's docs at https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/batchUpdate

---

## What if you need to revoke access?

Three layers, any one cuts forge off:

1. **Per-sheet** (least disruptive) — open the sheet → Share → remove the service account email
2. **Per-key** — delete the JSON file from your laptop (`rm /Users/davidmohamed/cortextos/orgs/personal/secrets/sheets-sa.json`) → forge gets "Cannot read service account key" on next call
3. **Account-wide** (most disruptive) — Google Cloud Console → IAM & Admin → Service Accounts → click yours → Disable. All keys for that SA stop working everywhere.

Each layer is reversible (re-share / put the file back / re-enable the SA).

---

## What gets logged

Every `update-sheet` call emits a bus event of category `action`, name `sheet_updated`, with metadata including:

- which operation (`append` / `set_cell` / `batch_update`)
- the spreadsheet ID
- counts (rows / updated cells / request count)

So you can audit "what did forge edit in my sheets and when" via the cortextOS activity feed at any time. No edit goes unrecorded.
