# Deploy: Pebble Bridge → Pebble

[Pebble Bridge](../../Pebble%20Bridge/) is a local-first, single-user iMessage
bridge that runs on the same Mac as your iMessage account. It exposes a
loopback HTTP API (`/api/v1/chats`, `/messages`, `/messages/send`) and an SSE
stream (`/api/v1/events`) of `message.created` envelopes. Pebble has a
matching `pebble-bridge` adapter that consumes those envelopes, plus a
forwarder script in the Bridge repo that connects the two.

This is the **recommended** ingestion path: no cloud relay, no third-party
SaaS, no telemetry. Both processes run on the same Mac (or LAN-localhost).

## Architecture

```
iMessage (chat.db)
   │
   ▼
Pebble Bridge   :8989   ── localhost ──┐
   │  GET /api/v1/events (SSE)         │
   ▼                                   │
forward-to-pebble.ts (Bridge repo)     │  POSTs each event as-is
   │                                   │
   └───────────────────────────────────┘
                  │
                  ▼
           Pebble  :8787
           POST /ingest
           (pebble-bridge adapter)
                  │
                  ▼
           Vault + SQLite + triage
```

The forwarder has no local state. The Bridge replays from its server-startup
watermark; Pebble's own `original_text_hash` dedup drops repeats if the
forwarder reconnects.

## One-time setup

### 1. Bridge

In `~/Projects/Pebble Bridge`:

```bash
make install
cp .env.example .env
# edit .env: set PAIRING_CODE and SEND_PROVIDER as needed
make dev
```

The Bridge needs **Full Disk Access** for your terminal so it can read
`~/Library/Messages/chat.db`. See `docs/SETUP_MACOS.md` in that repo.

Get a token by pairing once (10-minute window after server start):

```bash
curl -X POST http://127.0.0.1:8989/api/v1/pair \
  -H 'content-type: application/json' \
  -d '{ "pairing_code": "<from .env>", "client_name": "pebble-forwarder" }'
# → { ok: true, data: { token: "<save this>", ... } }
```

### 2. Pebble

Standard Pebble setup (`README.md`). Note the values you'll need next:

- `PEBBLE_INGEST_SECRET` — Pebble's own bearer token.
- `PEBBLE_INGEST_URL` — usually `http://127.0.0.1:8787/ingest`.

### 3. Forwarder

Back in the Bridge repo, edit its `.env`:

```env
BRIDGE_URL=http://127.0.0.1:8989
BRIDGE_TOKEN=<paired token from step 1>
PEBBLE_INGEST_URL=http://127.0.0.1:8787/ingest
PEBBLE_INGEST_TOKEN=<PEBBLE_INGEST_SECRET>
FORWARD_FROM_ME=false
```

Then start it:

```bash
npx tsx scripts/forward-to-pebble.ts
```

Send yourself a message in the Messages app — within ~1 s a new note should
appear under `Inbox/` in the vault.

## Why prefer the Bridge over BlueBubbles

|                      | Pebble Bridge                                  | BlueBubbles Server                              |
| -------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Hosting              | Same Mac, single-user, loopback only           | Same Mac, optionally exposed via Cloudflare     |
| Multi-device         | No (by design)                                 | Yes (Android/web clients)                       |
| Auth                 | Pairing-code → bearer tokens, Keychain storage | Server password                                 |
| Attachment fetching  | Local FS access; bytes available on the same Mac | Webhook carries metadata only; needs the BB fetcher to fill bytes |
| Telemetry            | None                                           | None                                            |

If you only need self-host ingestion into Pebble, the Bridge is simpler and
keeps the entire surface on `127.0.0.1`. If you also want to read iMessages
from your phone via a web client or share with another device, BlueBubbles
gives you that out of the box.

## Troubleshooting

- **Forwarder logs `503 TOO_MANY_SUBSCRIBERS`** — the Bridge caps SSE at 8
  concurrent subscribers. Check for stale forwarder processes
  (`pgrep -f forward-to-pebble`).
- **No events arriving** — the Bridge watermark starts at server boot, so
  *historical* messages aren't replayed. Send a fresh test message after
  starting both processes.
- **`401 unauthorized` from Pebble** — `PEBBLE_INGEST_TOKEN` in the
  forwarder must match `PEBBLE_INGEST_SECRET` in Pebble's `.env`.
- **Self-chat double-fires** — already handled. The pipeline's echo
  suppression (`findEchoDuplicate`, 60 s) and the `pebble-bridge` adapter's
  own `is_from_me` filter (when `FORWARD_FROM_ME=false`) both apply.
