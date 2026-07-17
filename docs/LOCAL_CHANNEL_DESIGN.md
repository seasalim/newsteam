# Local Channel Design

Status: implemented.

A "local" channel provider that replaces Discord with a chat UI served from
the existing NewsTeam dashboard. Self-hosters get a complete experience with
zero external accounts, and demo mode can drive the same UI instead of the
bespoke console chat.

## Motivation

Discord is the only chat surface today. That means every self-hoster must
create a Discord application, obtain a bot token, enable developer mode, copy
user and channel snowflakes, and invite the bot to a server — none of which
has anything to do with reading news. Demo mode works around this with a
separate console REPL (`src/demo.ts`) that duplicates chat plumbing and
renders markdown for terminals.

The dashboard already runs a dependency-free HTTP server on `127.0.0.1:7777`.
Adding a chat surface there gives us:

- **Simpler self-hosting** — `cp config.example.yaml config.yaml`, add an API
  key, `npm start`, open a browser. No Discord setup.
- **One demo path** — the demo starts the same server with a temp workspace;
  the console chat loop and terminal markdown renderer can be retired.
- **A foundation for richer UX** — digests with real links, tables, and
  confirmation buttons instead of emoji reactions.

## Goals

- A `ChannelAdapter` interface with two implementations: `discord` (current
  behavior, unchanged) and `local` (new).
- Full feature parity for the local provider: chat, slash commands, scheduled
  digest/synthesis delivery, tool confirmations, typing indicator, rate
  limiting, and the still-thinking queue semantics.
- Zero new npm dependencies. Server-sent events (SSE) over the existing
  `node:http` server; a self-contained HTML/JS page like the dashboard.
- Transcript persistence so the chat survives restarts (Discord gives us this
  for free today; the local channel must provide its own).
- Demo mode runs on the local channel; console demo chat is removed.

## Non-goals

- Multi-user support. NewsTeam is single-user by design (AGENTS.md); the
  local channel keeps that model. The auth gate changes shape (see
  [Security](#security)) but not intent.
- Running Discord and local providers simultaneously. One provider per
  deployment keeps channel-ID ownership unambiguous. Revisit later if asked.
- Mobile apps, push notifications, or remote hosting hardening beyond a
  shared-token gate. Users who expose the port take on reverse-proxy/TLS
  themselves (documented in `docs/DEPLOY.md`).
- Message editing, threads, reactions (beyond confirmations), or file upload.

## Current coupling audit

What actually touches Discord today:

| Site | Dependency | Notes |
| --- | --- | --- |
| `src/bot.ts` | discord.js client, slash commands, reactions | The whole file |
| `src/bot-messaging.ts` | 2000-char `splitMessage`, sendable-channel checks | Discord limits only |
| `src/index.ts` | `createBot(...)` + callback wiring, `DISCORD_TOKEN` check | Callbacks are already transport-neutral |
| `src/heartbeat.ts` | `bot: { sendToChannel }` | Already structurally typed — no change needed |
| `src/feed-digest.ts` / `feeds.ts` | same structural `bot` param | No change needed |
| `src/agent.ts` (`ConfirmFn`) | none directly | `index.ts` builds it from `bot.requestConfirmation` |
| `src/config.ts` | `discord.allowed_user_id` required | Must become conditional |

Channel IDs are validated as non-empty strings with no snowflake format
check, and the no-overlap invariant is provider-independent. In local mode
they become human-readable slugs (`kingclawd-chat`, `kingclawd-feed`).

## Architecture

### ChannelAdapter interface

New module `src/channel.ts`:

```ts
export interface ChannelCallbacks {
  onMessage: (message: string, channelId: string) => Promise<string>;
  onStats: (channelId: string) => string;
  onClear: (channelId: string) => string | Promise<string>;
  onCost?: (channelId: string) => string;
  onReplay?: (channelId: string) => string | null;
  onHealth?: () => string;
  onDigest?: (channelId: string) => Promise<string>;
  onRefresh?: (channelId: string) => Promise<string>;
}

export interface ChannelAdapter {
  /** Connect / begin accepting messages. Discord: client.login(). Local: register routes. */
  start(): Promise<void>;
  /** Push an unsolicited message (digest, synthesis) into a channel. */
  sendToChannel(channelId: string, text: string): Promise<void>;
  /** Ask the user to approve a tool call; resolve false on timeout. */
  requestConfirmation(channelId: string, preview: string, timeoutMs: number): Promise<boolean>;
  /** Graceful shutdown. */
  stop(): Promise<void>;
}
```

`ChannelCallbacks` is `BotConfig` minus the transport fields — `index.ts`
already builds exactly this object, so the wiring moves without changing.
`createBot` becomes `createDiscordAdapter(config): ChannelAdapter` (a thin
rename plus `start`/`stop` wrappers around `login`/`destroy`).

The per-channel in-flight / queued-message / rate-limit logic currently
inside `createBot` (lines 66–199 of `bot.ts`) is transport policy, not
Discord policy — the local channel needs identical behavior ("still
thinking…" when a second message arrives mid-turn). Extract it into
`src/channel-session.ts`:

```ts
export type SubmitResult = "accepted" | "queued" | "busy" | "rate_limited";

export interface ChannelSessionOptions {
  rateLimitMs: number;
  process: (text: string, channelId: string) => Promise<string>;   // wraps callbacks.onMessage
  deliver: (channelId: string, text: string) => Promise<void>;     // transport send
  setTyping?: (channelId: string, active: boolean) => void;        // typing indicator hook
}

export function createChannelSessions(options: ChannelSessionOptions): {
  /** Synchronous verdict; processing/queueing happens in the background. */
  submit(channelId: string, text: string): SubmitResult;
};
```

Semantics match today's `bot.ts` exactly: idle → `accepted`; one turn in
flight → `queued` (runs when the turn finishes); already one queued →
`busy`; within `rateLimitMs` of the last accepted message → `rate_limited`.
Each transport maps the verdict its own way: the Discord adapter replies
with the "🦞 Still thinking..." message on `busy`/`rate_limited` (current
behavior, previously the `notifyBusy` path inside `createBot`); the local
adapter returns the verdict in the POST response and never sends a
still-thinking chat message.

Both adapters use it; `bot.ts` shrinks accordingly (good — it is at 359 lines
against the 500-line convention, and the Discord-specific remainder is small).

### Local adapter and HTTP surface

New modules, all served by the existing dashboard server (`dashboard.ts`
gains a route-registration hook so the local channel can mount its endpoints
without a second port):

- `src/local-channel.ts` — adapter implementation, SSE hub, confirmation
  registry, command dispatch.
- `src/local-transcript.ts` — JSONL transcript persistence.
- `src/local-channel-page.ts` — static chat HTML/JS (same pattern as
  `dashboard-page.ts`).

#### Message model

```json
{
  "id": "m_01J...",              // monotonic ULID-style id (time-sortable)
  "channel_id": "kingclawd-chat",
  "role": "user" | "agent" | "system",
  "kind": "chat" | "digest" | "synthesis" | "command" | "confirmation" | "error",
  "text": "markdown...",
  "ts": "2026-07-17T18:03:12.412Z"
}
```

`kind` lets the UI style digests differently from chat replies and render
command output (`/stats`, `/cost`) as monospaced system cards.

#### Endpoints

| Route | Method | Purpose |
| --- | --- | --- |
| `/chat` | GET | Chat page (static HTML, like `/`) |
| `/api/chat/channels` | GET | `[{ channel_id, agent_id, is_feed_channel }]` from config |
| `/api/chat/history?channel=<id>&before=<msg id>&n=100` | GET | Paged transcript slice, newest last |
| `/api/chat/message` | POST | `{ channel_id, text }` → `202 { result: "accepted" \| "queued" }` or `409 { result: "busy" \| "rate_limited" }` (the `SubmitResult` verbatim); agent reply arrives via SSE |
| `/api/chat/events` | GET | SSE stream, all channels multiplexed |
| `/api/chat/confirm` | POST | `{ confirmation_id, approve }` |

SSE event types: `message` (full message object), `typing`
(`{ channel_id, active }`), `confirmation` (`{ confirmation_id, channel_id,
preview, expires_at }`), `confirmation_resolved` (`{ confirmation_id,
approved, timed_out }`). SSE writes are fire-and-forget to every connected
client; the transcript file is the source of truth and the UI reconciles on
reconnect by refetching history since its last seen message id (SSE
`Last-Event-ID` maps to the message id).

Responses to a user message are **not** returned from the POST — the agent
turn can take a minute. On `accepted`/`queued`, the *user's* message is
immediately appended to the transcript and broadcast on SSE (so history is
complete and other open tabs see it); the agent's reply follows the same
path when the turn completes. On `busy`/`rate_limited` nothing is persisted
— the composer keeps the text and shows the reason. This mirrors how
Discord works and keeps the channel-session queue semantics identical.

#### Slash commands

Typed into the same input box, parsed server-side before hitting the agent:
`/stats`, `/new`, `/cost`, `/replay`, `/health`, `/digest`, `/refresh` map to
the existing `ChannelCallbacks` exactly. Unknown `/x` text falls through to
the agent as a normal message (matching Discord, where unregistered slash
text is just a message). Command output is appended as a `role: system,
kind: command` message.

#### Confirmations

`requestConfirmation(channelId, preview, timeoutMs)`:

1. Create `{ confirmation_id, resolve }` in an in-memory registry; append a
   `kind: confirmation` message to the transcript; broadcast `confirmation`.
2. UI renders the preview with Approve / Deny buttons and a countdown.
3. `POST /api/chat/confirm` resolves the promise; a timeout resolves `false`
   (same rejection-on-timeout semantics as the Discord reaction flow).
4. Broadcast `confirmation_resolved` so every open tab disables the buttons,
   and append a system message recording the outcome.

Pending confirmations do not survive restart — they resolve `false` on
shutdown, which is the safe direction (tool call denied).

#### Transcript persistence

Per channel JSONL at `persona/<agent>/local_channel/<channel_id>.jsonl`
(inside the persona dir, which is already gitignored and already holds
per-agent runtime state like `feeds_pending.json`). Append-only during
operation; on startup, any file over 5,000 lines is compacted to its last
2,000. History endpoint reads tail slices — no index needed at this scale
(single user, bounded file).

Note this stores *display* history only. The agent's conversation window
stays in-memory in `AgentLoop` exactly as today; restarts still reset agent
context (as they do with Discord). The transcript keeps the human-visible
record continuous.

#### No message splitting

`splitMessage`'s 2000-char chunking is a Discord constraint and does not
apply. The local adapter sends whole messages; the UI scrolls.

### Chat UI

Same conventions as the dashboard page: one exported template string, no
external assets, dark/light theme with the same CSS variables, `localStorage`
theme persistence. Layout:

- Left rail: channel list grouped by agent, with the feed channel badged;
  unread dot driven by SSE while a channel is unfocused.
- Main pane: message stream. Agent/system messages render markdown; user
  messages render as plain text. Typing indicator row while `typing` is
  active. Confirmation cards inline.
- Composer: textarea (Enter sends, Shift+Enter newline), disabled-with-
  spinner only when the channel reports `busy` — matching the queue-one-
  message semantics, the composer stays usable and the server queues or
  bounces.
- Channel header: agent/channel name, a "New conversation" button (same code
  path as the typed `/new`, behind an inline confirm), and a cross-link
  between `/chat` and `/` (dashboard), so "Mission Control" and chat feel
  like one app.

Markdown: a small sanitizing renderer written for this page (headings, bold/
italic, links opening in a new tab, inline code, fenced code, lists,
blockquotes — the subset digests actually use). All text is HTML-escaped
first, then markdown constructs are re-applied; no `innerHTML` of raw model
output. This is the web sibling of `terminal-markdown.ts` and lives in the
page script. If it grows past trivial, extract to `src/web-markdown.ts` with
its own tests and inject it into both the page template and tests.

## Configuration

New optional top-level `channel` section:

```yaml
# config.example.yaml
channel:
  provider: local        # "discord" | "local"; selected by the public template
```

Rules, enforced in `config.ts`:

- `provider: discord` (also the compatibility fallback when omitted) → current behavior exactly:
  `discord.allowed_user_id` required, `DISCORD_TOKEN` required at startup.
- `provider: local` → the `discord:` section and `DISCORD_TOKEN` become
  optional and unused. `channel_ids` entries are free-form slugs; the
  existing uniqueness/no-overlap validation is unchanged.
- Local provider serves on the dashboard port (7777). `DASHBOARD_HOST`
  governs binding as today.

`config.example.yaml` selects local mode and uses slug-style channel IDs, so a
fresh self-hosted setup needs no Discord configuration. The Discord block is
kept as a commented alternative.

`SwarmConfig.discord` becomes optional in types; `resolveAgentConfig`'s
`discord.allowed_user_id` passthrough is only populated for the Discord
provider. This is the one type change that fans out — `index.ts` and
`dashboard.ts` touch `swarmConfig.discord` today and must go through the
provider switch instead.

## Security

The single-user authorization gate is preserved but changes mechanism, which
AGENTS.md flags as requiring explicit implementation and tests:

- **Identity**: Discord identified the user by snowflake. Locally, identity
  is possession of access to the page. Default binding stays `127.0.0.1`,
  which limits access to the machine's local users.
- **Token gate (opt-in — decided)**: no token is required by default; the
  priority is a frictionless localhost experience, and loopback binding is
  the default boundary. If `LOCAL_CHANNEL_TOKEN` is set in the environment,
  every
  `/api/chat/*` request (including the SSE stream) must present it
  (`Authorization: Bearer` or a cookie set by a `/chat?token=` first visit
  that immediately strips the query param via redirect). Startup **warns
  loudly** if `DASHBOARD_HOST` is non-loopback and no token is set, and the
  docs treat token + reverse proxy w/ TLS as the supported way to expose it.
- The read-only dashboard endpoints keep their current (no-auth) behavior on
  loopback; when a token is configured it protects those too, since feed
  titles and event logs are also personal data.
- SSE and POST endpoints validate `channel_id` against configured channels —
  unknown channels 404, mirroring `isAllowed`'s channel check.
- CORS: none needed (same-origin only); explicitly do not add permissive
  headers. `Content-Security-Policy` header on `/chat` restricting to
  `'self'`/inline, since we now render model-derived markdown.

## Demo mode

`npm run demo` becomes: terminal onboarding as today (provider key, persona
pick via `collectDemoSetup` — a terminal prompt is still the right tool
before any server exists), then instead of a console REPL:

1. Build the temp workspace (`createDemoWorkspace`, unchanged).
2. Start the HTTP server with the local adapter on one demo channel
   (`demo`), feed channel same as chat channel. Note the demo builds a bare
   `AgentLoop`, not an `AgentManager`, so it cannot supply the full
   `DashboardDeps` that `startDashboard` wants — the route-registration
   split in `dashboard.ts` should therefore separate "create the HTTP
   server + mount routes" from "mount the dashboard's own status routes",
   letting the demo run chat routes only (chat-only server; `/` can
   redirect to `/chat`). The demo wires `ChannelCallbacks.onMessage` to
   `agent.chat(...)` itself, with `onStats`/`onCost` backed by its
   `BudgetTracker` and `onClear` by `clearWindow()`; the digest-oriented
   callbacks (`onReplay`, `onDigest`, `onRefresh`) may be omitted — the
   command handler reports "not available in the demo" for absent
   callbacks (same as Discord silently skipping unset ones, but with
   feedback).
3. Kick off the same feed-check → digest flow, delivered through
   `sendToChannel` — it appears in the browser as the opening message.
4. Print `Demo running — open http://127.0.0.1:7777/chat` (and attempt to
   open the browser via `open`/`xdg-open`, best-effort).
5. Ctrl-C tears down the server and cleans the workspace as today.

Deletions once this lands: the readline follow-up loop and console rendering
in `demo.ts`, `terminal-markdown.ts` and its tests (verify no other
importers), and the `deliveryTarget: "console"` branch in the digest prompt
builder (becomes `"local"` or just the default). `demo-setup.ts` /
`onboarding.ts` / `demo-support.ts` survive intact.

The demo stops being Gemini-only-by-code-path eventually, but that is out of
scope here; the provider check in `demo.ts` carries over.

## Implementation plan

Phased so each lands green with the Discord path never broken:

1. **Extract the seam** — `src/channel.ts` (types), `src/channel-session.ts`
   (queue/rate-limit logic moved out of `bot.ts` with its behavior pinned by
   new tests), `createBot` → `createDiscordAdapter` conforming to
   `ChannelAdapter`. `index.ts` talks only to the interface. Pure refactor;
   Discord behavior identical.
2. **Config** — `channel.provider` parsing + conditional `discord`/token
   requirements + validation tests. `index.ts` gains the provider switch;
   selecting `local` at this stage exits with "local channel is not yet
   implemented" (removed in phase 3). Keep `channel:` out of
   `config.example.yaml` until phase 4 ships the UI.
3. **Local adapter, headless** — `local-channel.ts`, `local-transcript.ts`,
   route mounting in `dashboard.ts`. Tested at the HTTP level with the node
   test runner (POST message → SSE reply, busy/queue semantics, command
   dispatch, confirmation approve/deny/timeout, history paging, token gate,
   unknown-channel 404, transcript compaction).
4. **Chat UI** — `local-channel-page.ts` + markdown renderer (+ tests if
   extracted). Manual verification against a live agent.
5. **Demo on local channel** — rewire `demo.ts`, delete console chat path
   and `terminal-markdown.ts`, update README/AGENTS.md/`docs/DEPLOY.md` and
   `config.example.yaml`.

Rough size: phases 1–2 are moves plus ~150 new lines; phase 3 is the bulk
(~400–500 lines across two modules plus tests); phase 4 ~300 lines of page;
phase 5 net-negative.

## Resolved questions

- **`/new` from the UI**: yes — the channel header gets a "New conversation"
  button that calls the same code path as the typed `/new` command (with an
  inline confirm to prevent accidental resets). Lands in phase 4.
- **Link unfurling**: none in v1. Discord auto-unfurls; the local UI renders
  links as plain anchors opening in a new tab. Unfurling means fetching
  third-party URLs server-side — extra surface and latency for little value
  in a digest UI. Revisit only if it proves annoying in practice.
- **Opening the browser from the demo**: best-effort platform dispatch —
  `open` (darwin), `cmd /c start` (win32), `xdg-open` (linux) — with any
  failure swallowed; the printed URL is the reliable path. WSL (where
  `xdg-open` is usually absent) just gets the printed URL; note this in
  `docs/DEPLOY.md`'s WSL section.
