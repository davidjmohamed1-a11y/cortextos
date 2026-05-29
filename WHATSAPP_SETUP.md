# WhatsApp Setup (one-time)

This walks you through setting up WhatsApp so cortextOS agents (like kai) can send messages. It is a Meta Business product — there are a few manual steps you must do on Meta's website that no one else can do for you. Plan for 30–60 minutes the first time.

You only have to do this once. After it's set up, agents can send WhatsApp messages with one command.

---

## What you're setting up, in plain English

You're creating a "business" phone number on WhatsApp that your agents will send messages from. Recipients will see messages from this number, not from your personal WhatsApp.

You'll end up with two secret values that go into a config file: an **access token** (like a password) and a **phone number ID** (Meta's internal label for your business number). Once those are saved, agents can send messages.

---

## Important limitation up front: the 24-hour window

WhatsApp has a strict rule. Your business can only send free-form messages to someone within **24 hours** of their last message to you. Outside that window, you must use an **approved template** — a pre-written message that Meta reviews and approves before you can use it.

For your use case (church reminders, surveys, follow-ups), you will almost certainly need at least one approved template. Template approval takes a few hours to a day.

---

## Step 1 — Create a Meta Business account

If you already have one, skip to Step 2.

1. Open https://business.facebook.com in a browser.
2. Click "Create Account".
3. Give it a business name (e.g. "YNG Christian Fellowship") and your email.
4. Verify your email when Meta sends the verification link.

That's it for this step. You now have a Business Manager.

---

## Step 2 — Add WhatsApp to your Business account

1. Inside Business Manager, go to **Settings → Business Settings → WhatsApp Accounts**.
2. Click **Add → Create a WhatsApp Business Account**.
3. Give it a name (this is internal, only you see it).

---

## Step 3 — Add a phone number for the business

You need a phone number that is **not currently registered on WhatsApp** (personal or business). If your personal number is on WhatsApp, you cannot reuse it for this without removing it from WhatsApp first.

Options:
- A second SIM you own
- A landline that can receive SMS or voice for verification
- A free number from Google Voice (US) or similar service

Then:
1. In Business Manager, go to your WhatsApp Account → **Phone Numbers → Add Phone Number**.
2. Enter the number, pick how you want Meta to verify it (SMS or voice call), and enter the code Meta sends.
3. Set a display name (this is what recipients see; e.g. "YNG Fellowship").

When this is done, you have a verified business number.

---

## Step 4 — Get your **Phone Number ID** and **Access Token**

You need two values from Meta.

### Get the Phone Number ID

1. Go to https://developers.facebook.com/apps and either pick your existing app or click "Create App" → "Business" type.
2. In the left sidebar, click **WhatsApp → API Setup**.
3. You'll see your phone number listed. Next to it is a long number labeled **Phone number ID**. Copy this.

### Get a permanent Access Token

The token shown on the API Setup page is a **temporary** 24-hour token. Useful for testing, useless for production.

To get a permanent one, you have to create a "System User":

1. Go to **Business Manager → Settings → Business Settings → Users → System Users**.
2. Click **Add** → give it a name (e.g. "cortextos-bot") → role **Admin**.
3. Click **Add Assets** → assign your WhatsApp Business Account → grant **Full control**.
4. Click **Generate New Token** → pick your app → select the permissions `whatsapp_business_messaging` and `whatsapp_business_management` → set token expiration to **Never** → generate.
5. Copy the token immediately. Meta only shows it once.

Treat this token like a password. Anyone with it can send messages from your business number.

---

## Step 5 — Save the credentials

Open your agent's `.env` file (e.g. `orgs/personal/agents/kai/.env`) and add these two lines:

```
WHATSAPP_ACCESS_TOKEN=<paste your permanent access token here>
WHATSAPP_PHONE_NUMBER_ID=<paste your phone number ID here>
```

If you'd rather share one credential across multiple agents, you can set them as system environment variables instead — but a per-agent `.env` is the simplest and safest default.

Restart the agent after editing `.env`:

```bash
cortextos stop <agent-name>
cortextos start <agent-name>
```

---

## Step 6 — Test sending a message

You can only send a free-form text message to a number that has messaged your business in the last 24 hours. For your first test:

1. Open WhatsApp on your phone, send any message to your new business number.
2. Then run (replacing the phone with your own in international format):

```bash
cortextos bus send-whatsapp +15555551234 "Test message from cortextos"
```

If it works, the command prints `Message sent (wamid: ...)`. The message arrives in WhatsApp on your phone within a few seconds.

If something is wrong, you'll see an error message describing it — most commonly:
- "Recipient phone number not in allowed list" — for sandbox/test mode, you have to whitelist test recipients in Meta's WhatsApp dashboard.
- "Re-engagement message" or similar — you're outside the 24-hour window; use a template instead.

---

## Step 7 (later) — Create an approved Message Template

For the kind of messages your agents will actually send (pre-gathering reminders, survey nudges, follow-ups), you need approved templates.

1. Go to **Business Manager → WhatsApp Manager → Message Templates → Create Template**.
2. Pick category **Utility** (or **Marketing** for promotional content).
3. Write the template. You can include placeholders like `{{1}}` `{{2}}` that you fill in when sending.
4. Submit for review. Meta usually approves utility templates within a few hours.

Once approved, send it from cortextos like this:

```bash
cortextos bus send-whatsapp +15555551234 "" --template gathering_reminder --lang en_US
```

(The text argument is ignored when `--template` is set; pass an empty string.)

---

## Quick reference: the bus command

```bash
# Free-form text (only valid within 24h of recipient's last inbound message)
cortextos bus send-whatsapp <phone> "<message>"

# Template message (required outside the 24h window)
cortextos bus send-whatsapp <phone> "" --template <template-name> --lang <language-code>
```

Phone numbers can be in any of these forms:
- `+15555551234`
- `15555551234`
- `+1 (555) 555-1234`
- `001 555 555 1234`

cortextos normalizes them automatically before sending.

---

## When something goes wrong

- **"WHATSAPP_ACCESS_TOKEN not configured"** — you haven't saved the credentials in `.env` (or you forgot to restart the agent after editing `.env`).
- **"code 190" (token error)** — your access token expired or was revoked. Generate a new one (Step 4) and update `.env`.
- **"code 131030" (recipient not in allowed list)** — your business is in test mode and the recipient isn't on the test list. Add them in the Meta WhatsApp dashboard, or move your app to "Live" mode once it's ready for general use.
- **"re-engagement message" error** — you tried to send free-form text outside the 24h window. Use a template (`--template`).

If you get stuck, paste the exact error text to your agent and they can interpret what Meta is telling you.
