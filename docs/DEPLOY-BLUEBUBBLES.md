# Deploy Pebble with BlueBubbles

End-to-end recipe for sending iMessages from your phone into a Pebble vault
on a server you control. Roughly: **iMessage → BlueBubbles Server (Mac) →
HTTPS tunnel → Pebble HTTP server → Obsidian vault**.

This is the path most self-hosters will take. If you'd rather use a paid
SaaS bridge, see the Sendblue / Texting Blue notes in
[`ROADMAP.md`](../ROADMAP.md#imessage-providers); the adapter is built but
this guide doesn't cover the SaaS side.

## What you'll need

- **A Mac you can leave running.** BlueBubbles needs an Apple-signed
  Messages.app session. A Mac mini, a spare laptop, or a VM-ed mac all work.
  Sleep settings: never sleep, never log out.
- **An Apple ID logged in to Messages on that Mac**, with iMessage enabled.
- **A host for Pebble** (the same Mac is fine; or any Linux box, container,
  Raspberry Pi). Node 22+.
- **A way to expose Pebble's HTTP port** to the BlueBubbles Server. If
  they're on the same LAN, that's free; otherwise see the tunnel section.

## 1. Install the BlueBubbles Server on your Mac

1. Download the macOS app from <https://bluebubbles.app>. It is open source.
2. Launch it. Grant Full Disk Access (System Settings → Privacy & Security)
   when prompted — BB needs to read `~/Library/Messages/chat.db`.
3. In the app's **Server → Configuration** tab, set a strong **server
   password**. This password authenticates every API call. Save it; you
   will need it on the Pebble side.
4. In **Server → API**, note the **port** (default `1234`) and the URL the
   app shows (something like `http://192.168.1.42:1234`).
5. Send yourself a test iMessage from another device. Confirm the message
   appears in the BB Server's log.

## 2. Install Pebble

```bash
git clone <your fork>/pebble.git
cd pebble
npm install
cp .env.example .env
```

Edit `.env`:

```bash
PEBBLE_VAULT_PATH=/absolute/path/to/your/Obsidian/Vault
PEBBLE_INGEST_SECRET=$(openssl rand -hex 32)   # paste the result back in

# BlueBubbles Server URL from step 1.4. No trailing slash.
PEBBLE_BLUEBUBBLES_URL=http://192.168.1.42:1234

# The BB password from step 1.3. Either paste it here, or — better —
# use the OS keychain (see "Secrets" below).
# PEBBLE_BLUEBUBBLES_PASSWORD=...
```

Initialize the vault layout and DB:

```bash
npm run cli -- init
npm run cli -- doctor
```

`doctor` will warn if the BB Server is unreachable.

## 3. Point BlueBubbles at Pebble's `/ingest`

In BlueBubbles Server, open **Server → Webhooks → Add webhook**:

- **URL**: `http://<pebble-host>:8787/ingest` (or the public URL from the
  tunnel section if Pebble lives off-LAN).
- **Events**: at minimum **`new-message`**. Other events are ignored by
  the adapter today.
- **Custom headers**: add **`X-Pebble-Token`** with the value of
  `PEBBLE_INGEST_SECRET`. This is the only auth Pebble enforces.

Send yourself another iMessage. You should see a `202 Accepted` from Pebble
and a fresh row appear in `<vault>/Inbox/<today>.md`.

## 4. Tunnel options (only if Pebble is off-LAN)

If your Mac and Pebble host live on the same network, skip this — BB will
just hit Pebble directly. If Pebble runs on a VPS or you want to ingest
from outside your LAN:

- **Tailscale** (easiest, no public IP needed): install on both machines,
  point the BB webhook at the Pebble host's `100.x.y.z:8787`. Auth is the
  Tailnet plus `X-Pebble-Token`.
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:8787`.
  Get a public HTTPS URL; paste it into the BB webhook.
- **ngrok**: `ngrok http 8787` for ad-hoc testing. Token rotates per
  session unless you have a paid plan.

For all of these, **do not expose `/api/*`, `/recent`, or `/dashboard`
publicly without auth** — Pebble already requires `X-Pebble-Token` on every
non-`/health` route, but you should still narrow the tunnel to `/ingest`
where possible. Cloudflare access policies / Tailscale ACLs are good for
this.

## 5. Secrets via the OS keychain (recommended)

Rather than committing `PEBBLE_INGEST_SECRET` and the BB password into
`.env`, you can store them in the OS keychain:

```bash
# Seed the keychain.
echo -n "<your-ingest-secret>"     | npm run cli -- secrets set PEBBLE_INGEST_SECRET
echo -n "<your-bluebubbles-pass>"  | npm run cli -- secrets set PEBBLE_BLUEBUBBLES_PASSWORD

# Tell Pebble to read keychain first, env as fallback:
#   PEBBLE_SECRETS_SOURCE=auto
```

`pebble doctor` will confirm the secrets resolve. The keychain backend
uses `security` on macOS and `secret-tool` on Linux. See
[`README.md`](../README.md#security--privacy) for the full design.

## 6. Attachments

The BlueBubbles webhook only carries attachment metadata (guid, mime,
filename) — not the bytes. When `PEBBLE_BLUEBUBBLES_URL` is set, Pebble
uses the configured BB password to fetch the binary at ingest time and
materializes it under `<vault>/_System/attachments/`. The vault note
references the local path, so it works fully offline thereafter.

If you leave `PEBBLE_BLUEBUBBLES_URL` unset, attachment URIs land as
`bluebubbles://attachment/<guid>` placeholders that you can resolve later.
The original markdown remains valid — just unresolved.

**Privacy:** attachments are stored locally and never auto-uploaded to
your AI provider. If you want a model to consider an attachment, you have
to reference it explicitly through the agent's tools.

## 7. Run Pebble

```bash
npm run dev   # development mode, file-watched
# or
npm run build && npm start    # production mode, after tsc
```

Open `http://localhost:8787/dashboard?token=<PEBBLE_INGEST_SECRET>` to
view the inbox, search the vault, and approve filing decisions.

For the server to stay up after you log out, wrap it in a `launchd` plist
(macOS) or a `systemd` unit (Linux). A minimal launchd template:

```xml
<!-- ~/Library/LaunchAgents/dev.pebble.server.plist -->
<plist version="1.0"><dict>
  <key>Label</key><string>dev.pebble.server</string>
  <key>WorkingDirectory</key><string>/Users/you/Projects/Pebble</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>--env-file-if-exists=.env</string>
    <string>dist/server/index.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/pebble.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/pebble.err.log</string>
</dict></plist>
```

Load with `launchctl load ~/Library/LaunchAgents/dev.pebble.server.plist`.

## 8. Verify end-to-end

```bash
# 1. Pebble side
npm run cli -- doctor

# 2. Send a test message from another Apple device.
# 3. Tail the inbox.
ls -lt <vault>/Inbox | head
cat $(ls -t <vault>/Inbox/*.md | head -1)

# 4. Open the dashboard and confirm the row.
open "http://localhost:8787/dashboard?token=$PEBBLE_INGEST_SECRET"
```

If the message arrives in `Inbox/<today>.md`, in
`Sources/iMessage/<thread>.md`, and as a row on the dashboard — the
pipeline is wired correctly end-to-end.

## Troubleshooting

| Symptom                              | Likely cause / fix                                             |
| ------------------------------------ | -------------------------------------------------------------- |
| BB webhook gets 401 from Pebble      | `X-Pebble-Token` header missing or doesn't match `.env`        |
| 400 `invalid_payload` from `/ingest` | BB sent an event other than `new-message`; the adapter falls through and the manual fallback rejects it. Configure BB to send only `new-message`. |
| Attachment cells say `bluebubbles://…` in the markdown | `PEBBLE_BLUEBUBBLES_URL` not set, or BB password missing/wrong. Run `pebble doctor`. |
| `pebble doctor` says BB is unreachable | LAN / firewall blocks the port; or BB Server isn't running; or password wrong. |
| iMessage arrives but no webhook fires | BB Server's webhook tab is paused, or the URL in BB is the wrong one (typo, https vs http). |

Logs to read first: BB Server's in-app log, then `tail -f /tmp/pebble.err.log`,
then `<vault>/_System/ingestion-log.jsonl`.
