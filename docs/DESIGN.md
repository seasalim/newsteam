# NewsTeam Design

NewsTeam is a self-hosted local-browser/Discord harness for personality-driven AI
news analysts. It is intentionally small: one Node.js process coordinates
channel delivery, model providers, feeds, tools, budgets, memory, and a dashboard.

## System overview

```text
Local chat or Discord
   │
   ▼
Channel adapter ──► per-agent job queue ──► AgentLoop ──► Anthropic, Gemini, or OpenAI
                                           │
                                           ├──► budget + cost ledger
                                           ├──► bounded memory
                                           └──► validated tool executor
                                                     │
                                                     └──► Python/Node handlers

Heartbeat ──► feed detection ──► pending queue ──► digest narration ──► channel
```

The local provider is loopback-only by default and supports an optional shared
token; Discord is authenticated to one configured user. Both use a fixed set
of channels. Multiple analysts share the process but keep separate personas,
conversation windows, budgets, feeds, and runtime artifacts.

## Runtime configuration

`config.yaml` is deployment-specific and ignored by Git. Create it with:

```bash
cp config.example.yaml config.yaml
```

The top-level `defaults` block defines budget, conversation, and memory
settings. Each entry under `agents` supplies:

- a unique `id`
- a private `persona_dir`
- one or more provider-specific `channel_ids`
- optional budget overrides
- optional feed scheduling and delivery settings
- optional environment-variable aliases
- optional channel-specific persona overlays

The public template selects local browser chat; set `channel.provider` to
`discord` and configure its user/channel IDs to use Discord instead.
`resolveAgentConfig()` merges agent overrides with defaults and validates the
resolved result. Chat and digest models for one agent must use the same
provider. Channel IDs cannot be assigned to more than one agent.

Secrets live in `.env`, never in YAML. Required variables are documented in
`.env.example`; one of `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, or
`OPENAI_API_KEY` is required for the configured provider. `BRAVE_API_KEY` is
needed only by `web_search`.

## Agent lifecycle

`AgentManager` creates one `AgentLoop` per configured agent. Incoming channel
messages are mapped to an agent by channel ID and queued so one agent never
runs two conversations or feed jobs concurrently. User work takes priority
over scheduled feed work.

For each message, `AgentLoop`:

1. checks the hard session budget;
2. assembles the system prompt from identity, optional channel overlay, memory,
   and security instructions;
3. trims or summarizes conversation context to the configured input budget;
4. calls the selected provider with validated tool schemas;
5. executes requested tools through the capability-limited executor;
6. records tokens, model-specific cost, turns, and tool use;
7. flushes accepted memory updates after the job completes.

The final allowed turn disables tools so the model must return a direct answer.
Provider thought text is excluded from Discord output, and responses are
checked for a per-session canary used to detect prompt exfiltration.
When `context_strategy` is `summarize`, `context_summary_max_tokens` caps the
internal compaction response. It defaults to 500 (or the lower configured
`max_output_tokens`) and can be overridden per agent.

## Personas and memory

An active persona directory can contain:

- `IDENTITY.md` — core role, personality, and voice
- `INTERESTS.md` — weighted news priorities
- `LENS.md` — digest framework and writing rules
- `MEMORY.md` — bounded long-term memory managed by the agent
- `feeds.json` — feed registry and fetch guidance
- runtime feed context, queues, archives, and quality records

All active persona files are private and ignored by Git. Public starter
personas live under `examples/personas/` and are copied into `persona/` during
setup.

Memory is deliberately small. The built-in `remember` capability is intended
for durable preferences, names, relationships, and decisions—not a transcript
of everything the agent sees.

## Model providers and cost

Provider selection comes from the model prefix:

- `anthropic/...` uses the Anthropic adapter
- `google/...` uses the Gemini adapter
- `openai/...` uses the OpenAI Responses API adapter

`budget.model` controls chat. `budget.digest_model` can select a deeper model
from the same provider for digests, evaluations, and weekly synthesis. Neutral
request/response types in `llm-types.ts` keep provider-specific translation out
of the agent loop.

Model rates live in `src/model-cost.ts`. Exact IDs, dated variants, and preview
suffixes resolve to known rates where possible. Unknown models produce a
startup warning and use the documented fallback rate rather than silently
recording zero cost.

`BudgetTracker` enforces input, output, turn, and session-cost limits. The
append-only cost ledger records chat, digest, and synthesis usage by agent and
day for the dashboard and `/cost` command.

## Tool security model

Tools are capabilities, not shell access. At startup `ToolRegistry` discovers
subdirectories of `tools/` that contain `manifest.json`. A manifest declares
the only model-visible name and parameters, the handler runtime, allowed
secrets, and execution timeout. Arguments are validated before execution.

`ToolExecutor` launches the declared handler directly, passes JSON over
standard input, injects only manifest-declared secrets plus trusted runtime
context such as the invoking agent's persona directory, enforces timeouts and
rate limits, optionally validates output, and wraps results as untrusted
external data before returning them to the model. Handlers do not inherit the
full parent environment, and the model cannot choose an arbitrary executable.

The shipped tools are:

| Tool | Purpose | Runtime | Secret |
|---|---|---|---|
| `web_search` | Search the web through Brave | Python | `BRAVE_API_KEY` |
| `web_fetch` | Fetch readable text from a URL | Python | none |
| `feed_manage` | List feeds and inspect scheduler status/new items (read-only) | Python | none |
| `recall` | Search persona memory | Node.js | none |

### Writing your own tool

Create a directory such as `tools/weather/` containing a handler and
`manifest.json`. The harness discovers it on the next startup; no central
registration is required.

```json
{
  "name": "weather",
  "description": "Get current weather for a city.",
  "parameters": {
    "type": "object",
    "properties": {
      "city": { "type": "string", "description": "City and country" }
    },
    "required": ["city"]
  },
  "secrets": ["WEATHER_API_KEY"],
  "timeout_ms": 5000,
  "handler": "handler.py",
  "runtime": "python"
}
```

Manifest fields:

- `name` — unique model-facing tool name
- `description` — when and why the model should call it
- `parameters` — JSON Schema for accepted arguments
- `secrets` — allowlist of environment variables injected into the handler
- `timeout_ms` — hard subprocess timeout
- `handler` — file path relative to the tool directory
- `runtime` — `python` or `node`

Optional fields include confirmation requirements, rate limits, and an output
schema. The locally enforced schema subset is documented in
[SCHEMA.md](SCHEMA.md).

A handler reads one JSON object from standard input and writes its JSON result
to standard output. Write diagnostics to standard error, return a nonzero exit
status on failure, keep output bounded, and treat all network content as
untrusted.

## Feed subsystem

The feed subsystem separates deterministic detection from model narration.
Python parses RSS/Atom and updates seen-item state; no model call happens when
nothing is new. New items enter a per-agent pending queue and are delivered at
configured digest times. The digest prompt combines item snippets, persona
interests, the analytical lens, recent context, and source-specific fetch
guidance.

After delivery, a low-cost evaluation records digest quality and updates
per-source recommendations. Full digests are archived for weekly synthesis.
See [FEED_DESIGN.md](FEED_DESIGN.md) for formats, scheduling, and module
boundaries.

## Discord interface

The bot listens only to the allowed user in configured channels. It supports:

- `/stats` — current session statistics
- `/new` — clear conversation and reset the session budget
- `/cost` — daily and monthly ledger totals
- `/replay` — repost the latest digest
- `/health` — process, agent, and tool health
- `/digest` — deliver currently pending items
- `/refresh` — fetch all feeds and deliver new items

Messages are split safely at Discord limits, mentions are disabled on bot
output, and confirmation-capable tools use Discord reactions with a timeout.

## Observability and dashboard

`EventLogger` writes structured JSONL events under `logs/`. Digest, quality,
prompt, and synthesis metrics include agent/model context and cost data. The
dashboard serves local status, feeds, events, and ledger views on port 7777. It
binds to loopback by default; Docker sets `DASHBOARD_HOST=0.0.0.0` inside the
container and publishes the port only to host loopback.

## Deployment and failure behavior

Docker is the recommended deployment. Linux systemd and macOS launchd are also
supported; see [DEPLOY.md](DEPLOY.md).

Configuration and provider errors fail fast at startup. Model calls use bounded
retry behavior. Tool failures abort the current tool turn, while feed errors
are recorded per source so one bad feed does not prevent other sources from
being processed. Runtime queues and ledgers are persisted with atomic or
append-only file operations where appropriate.

## Source layout

- `src/agent*.ts` — agent loop, prompts, context, evaluation, and tool dispatch
- `src/bot*.ts` — Discord adapter and message handling
- `src/feed-*.ts`, `src/feeds.ts` — feed pipeline modules and compatibility exports
- `src/provider-*.ts`, `src/model*.ts` — provider adapters and cost resolution
- `src/config*.ts` — YAML loading, merging, and validation
- `src/budget.ts`, `src/ledger.ts`, `src/logger.ts` — limits and observability
- `src/dashboard*.ts` — local dashboard server and page
- `tools/` — capability manifests and handlers
- `examples/personas/` — public starter personas
- `persona/` — private runtime personas and state
