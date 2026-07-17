# NewsTeam

> Your personal news team. No subscription. Start for $0.

NewsTeam is a self-hosted local-browser/Discord harness for personality-driven
AI news analysts. One TypeScript process runs a multi-agent swarm,
deterministic RSS detection, scheduled LLM digests, source evaluation, weekly
synthesis, hard budgets, memory, tools, local chat, and a dashboard.

## Build and run

```bash
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p persona
cp -r examples/personas/kingclawd persona/kingclawd
cp -r examples/personas/the-analyst persona/the-analyst
npm ci
npm run build
npm start
```

The example config defaults to local chat at `http://127.0.0.1:7777/chat`;
Mission Control is at `/`. Add the configured model API key before starting.

Verification commands:

```bash
npm run build
npm test
python3 -m unittest tests/test_feed_check.py tests/test_feed_manage.py -v
```

Deployment commands:

```bash
docker compose up -d --build  # recommended
npm run deploy               # build + restart macOS launchd service
```

Linux systemd, macOS launchd, Docker, and Windows/WSL guidance lives in
`docs/DEPLOY.md`.

## Project layout

- `src/` — agent loop, channel adapters, feeds, providers, budget, memory,
  dashboard, and tool execution
- `tools/` — capability-limited handlers discovered through JSON manifests
- `scripts/feed-check.py` — standard-library RSS/Atom detection
- `examples/personas/` — public starter identities, interests, lenses, and feeds
- `persona/` — private active persona files and runtime state; never commit
- `tests/` — Node test-runner TypeScript tests and Python unittest suites
- `config.example.yaml` — committed configuration template
- `config.yaml` — private runtime configuration; ignored by Git
- `Dockerfile`, `docker-compose.yml` — recommended deployment
- `service/` — macOS launchd template and installer
- `docs/` — architecture, feed, schema, and deployment documentation

## Architecture

### Agents and channels

Each `agents` entry has its own persona directory, channel IDs, feed
configuration, budget, conversation window, and memory. `resolveAgentConfig()`
merges per-agent overrides with `defaults`. Channel IDs must not overlap.

`AgentManager` creates one `AgentLoop` and `JobQueue` per agent; jobs serialize
with user work ahead of feeds. One provider runs per deployment. Keep the
`ChannelAdapter` seam transport-neutral: it owns lifecycle, delivery, and
confirmation; `ChannelCallbacks` owns commands/chat; `channel-session.ts` owns
one in-flight turn, one queued message, busy/rate-limit behavior.

The example config selects `local`; omitted `channel` remains a Discord
compatibility fallback. Discord requires `discord.allowed_user_id` and
`DISCORD_TOKEN`; local uses slugs and ignores both. Keep chat/feed channel IDs
unique across agents and synchronize provider changes across the example env,
config, tests, and deployment docs.

Local chat mounts on the dashboard's existing `node:http` server and uses SSE,
JSONL display transcripts under `persona/<agent>/local_channel/`, and the same
callbacks as Discord. The transcript is not the in-memory conversation window.
See `docs/LOCAL_CHANNEL_DESIGN.md` for routes and persistence details.

Local security defaults to loopback. `LOCAL_CHANNEL_TOKEN` protects chat and
dashboard routes; non-loopback binding without it must warn. Keep POSTs
same-origin JSON, validate channels, retain CSP, avoid permissive CORS, and deny
pending confirmations on timeout/shutdown. Remote use requires TLS plus token.

Browser pages stay self-contained and escape model HTML before rendering the
Markdown subset. Preserve the chat scroll-container constraints and keep
Mission Control actions in normal responsive flow, not fixed/floating.

`npm run demo` performs terminal onboarding, then runs the same local UI from a
temporary workspace and cleans it on Ctrl-C. There is no console chat REPL.

### Model providers and budgets

Models are selected by prefix:

- `anthropic/...` — Anthropic provider
- `google/...` — Gemini provider
- `openai/...` — OpenAI Responses API provider

`budget.model` handles chat; `budget.digest_model` may choose a deeper model
from the same provider for digests, evaluations, and synthesis. Cost rates live
in `src/model-cost.ts`, and `BudgetTracker.record()` accepts per-call overrides
for accurate mixed-model accounting.

Hard input, output, turn, and per-session cost limits are enforced in the agent
loop. The cost ledger records chat, digest, and synthesis spend by agent.

### Feed pipeline

1. `scripts/feed-check.py` polls RSS/Atom and updates seen-item state.
2. New items accumulate in `feeds_pending.json` when digest times are set.
3. `agent.chat()` narrates selected items using `INTERESTS.md`, `LENS.md`,
   recent context, and fetch guidance.
4. A structured evaluation writes `digest_quality.jsonl` and updates advisory
   source-review statistics.
5. Full digests enter an archive used for weekly synthesis.

No model call occurs when detection finds nothing new. See
`docs/FEED_DESIGN.md` for data formats and scheduling.

Feed implementation is split across:

- `feeds.ts` — types, pending items, time helpers, feed-check runner, re-exports
- `feed-context.ts` — context, archive, interests, and lens loading
- `feed-digest.ts` — prompt, item selection, delivery, metrics
- `feed-fetch-guidance.ts` — source metadata and fetch expectations
- `feed-monitor.ts` — scheduled checks, refresh, delivery
- `feed-review.ts` — source-quality recommendations
- `feed-synthesis.ts` — weekly synthesis
- `feed-wiring.ts` — paths and callbacks for heartbeat/manual actions

New feed options must be threaded through monitor-cycle types, digest enqueue,
delivery/refresh, heartbeat, and the manual call sites in `index.ts`.

### Persona files

Active files under `persona/<agent>/` are private:

- `IDENTITY.md` — core personality and voice
- `INTERESTS.md` — Core/High/Medium domain priorities
- `LENS.md` — digest framework and style
- `MEMORY.md` — bounded agent-managed memory
- `feeds.json` — RSS registry with `fetch_hint` and `content_quality`
- feed state, pending queue, context, archive, quality, and source-review files
- `local_channel/*.jsonl` — display transcripts when the local provider is active

Never read, copy, or commit private persona files when preparing public
examples. Write examples from scratch under `examples/personas/`.

### Tool system

The four shipped tools are `web_search`, `web_fetch`, `feed_manage`, and
`recall`. Tools are discovered from `tools/*/manifest.json`. Manifests define
the model-facing name, JSON Schema parameters, declared secrets, timeout,
handler, and runtime.

The executor validates arguments, launches only the declared handler, injects
only allowlisted secrets plus trusted runtime context, enforces timeout/rate
limits, and wraps output as untrusted external data. There is no general shell
tool. See `docs/DESIGN.md` for the custom-tool guide and `docs/SCHEMA.md` for
the enforced schema subset.

## Conventions

- Source files should stay under 500 lines. Extract cohesive modules and
  preserve compatibility exports when a file grows beyond that limit.
- ES modules with NodeNext resolution; local TypeScript imports include
  extensions and are rewritten by the compiler.
- Tests use Node's built-in runner and Python `unittest`, not Jest or Vitest.
- Commit messages use `feat:`, `fix:`, or `chore:` prefixes.
- Use `config.example.yaml` for public configuration changes; never commit
  `config.yaml`, `.env`, logs, or active `persona/` content.
- Keep browser pages self-contained and dependency-free; local-channel work
  must not add npm packages without a separate explicit design decision.
- Tools are capability-limited handlers with JSON manifests, not arbitrary
  subprocess or shell access.
- Preserve the single-user channel auth gate unless a change explicitly
  implements and tests a new authorization model.

## Verification expectations

Run the TypeScript build and relevant tests after changes. Feed changes usually
require both the TypeScript suite and the two Python suites. Deployment changes
should validate YAML/plist/shell syntax as applicable; Docker changes should run
`docker build -t newsteam .` when Docker is available and explicitly report
when it is not.

Channel/config/UI changes should normally run the focused suites in
`tests/bot.test.ts`, `channel-session.test.ts`, `config.test.ts`,
`local-channel.test.ts`, `local-transcript.test.ts`, and
`web-markdown.test.ts`, followed by `npm test` for cross-system regressions.

`DigestMetrics`, `DigestQualityEvaluation`, and `SynthesisMetrics` are part of
observability behavior; update their tests and consumers when changing emitted
fields.
