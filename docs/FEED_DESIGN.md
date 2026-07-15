# Feed Pipeline Design

NewsTeam turns RSS and Atom sources into scheduled, personality-driven Discord
digests. The pipeline separates cheap deterministic detection from model-based
narration so an empty polling cycle costs no model tokens.

## Pipeline

```text
RSS / Atom
    │
    ▼
feed-check.py ──► seen-item state ──► pending queue
                                           │
                                      digest schedule
                                           │
                                           ▼
persona interests + lens + recent context + source guidance
                                           │
                                           ▼
                                      agent narration
                                           │
                           ┌───────────────┼───────────────┐
                           ▼               ▼               ▼
                        Discord       quality record   digest archive
                                                               │
                                                         weekly synthesis
```

The heartbeat checks each enabled agent independently. User conversations and
feed jobs share the agent's `JobQueue`; user work has priority, and scheduled
feed work is dropped or deferred rather than competing with an active reply.

## Feed configuration

Feed scheduling lives under an agent's `feeds` block in `config.yaml`:

```yaml
feeds:
  enabled: true
  check_interval_minutes: 15
  waking_hours_start: 7
  waking_hours_end: 22
  channel_id: "YOUR_FEED_CHANNEL_ID"
  max_items_per_digest: 20
  max_queue_age_hours: 12
  max_content_age_hours: 72
  digest_max_turns: 12
  digest_times: ["08:00", "13:00", "18:00"]
  synthesis_day: 0
  synthesis_time: "10:00"
```

Times use the process's configured Pacific-time helpers. `synthesis_day` uses
`0` for Sunday through `6` for Saturday. Without `digest_times`, newly detected
items are narrated immediately; with them, items accumulate until the next
delivery window.

Each persona owns a `feeds.json` registry. A typical RSS source is:

```json
{
  "id": "hacker-news",
  "name": "Hacker News",
  "type": "rss",
  "url": "https://news.ycombinator.com/rss",
  "fetch_hint": "always",
  "content_quality": "thin-snippet",
  "check_interval_minutes": 30,
  "max_items": 8
}
```

Required fields are `id`, `name`, `type`, and an RSS/Atom `url`. Useful optional
fields include:

- `check_interval_minutes` — source-specific polling interval
- `max_items` — per-check item cap
- `fetch_hint` — `auto`, `always`, or `never`
- `content_quality` — `unknown`, `thin-snippet`, `partial`, or `full-text`
- source-specific queue/content retention overrides

Use [feeds-example.json](feeds-example.json) as a starter or copy a complete
registry from [examples/personas](../examples/personas/README.md).

## Detection

`scripts/feed-check.py` is a standard-library Python program. It parses RSS 2.0
and Atom directly from bytes, normalizes timestamps, strips HTML and control
characters, caps snippets at 600 characters, and rejects non-HTTP(S) links.

Each feed has a salted next-due time to avoid synchronized polling. Detection
stores source item IDs and emits only unseen items. The `peek` action performs
a read-only check; normal checks update seen IDs and the next-due timestamp
atomically.

Supported actions are:

- `status` — report due state and seen counts without fetching
- `check` — poll due feeds and persist state
- `check_all` — poll every feed regardless of schedule
- `peek` — inspect new items without modifying state

Malformed feeds and network failures are returned as per-feed errors. One
source failure does not discard successful results from other feeds.

## Custom API feeds

Sources that are not RSS or Atom can use `type: "api-custom"` with a handler
path:

```json
{
  "id": "example-api",
  "name": "Example API",
  "type": "api-custom",
  "handler": "scripts/feeds/example-source.py",
  "check_interval_minutes": 120,
  "max_items": 5
}
```

The handler receives JSON on standard input:

```json
{
  "action": "check",
  "feed_config": {},
  "seen_ids": []
}
```

It returns an object with `new_items` and the updated `seen_ids`. Items can
include `id`, `title`, `url`, `published`, and `snippet`. Handlers run with a
30-second timeout and must not rely on undeclared shell behavior. Built-in RSS
should be preferred whenever a source publishes a usable feed.

## Pending queue and retention

Detected items are appended to `feeds_pending.json`. Each new item receives a
`queued_at` timestamp; deduplication preserves the first queue time. Items can
be pruned independently by:

- queue age — how long the item has waited for delivery
- content age — how old the underlying publication is

Per-feed retention settings override agent defaults. This allows a fast news
source to expire quickly while slower analytical sources remain eligible.

When a digest exceeds `max_items_per_digest`, `selectDigestItems()` round-robins
across feeds before taking second items from any source. Overflow remains in
the pending queue for the next delivery instead of being discarded.

## Narration prompt

`buildFeedDigestPrompt()` assembles:

1. selected items with source, title, URL, timestamp, and sanitized snippet;
2. `INTERESTS.md` priorities;
3. `LENS.md` analytical and voice instructions;
4. recent `feed_context.json` entries;
5. feed-specific fetch guidance;
6. grounding rules that separate source facts from inference.

The prompt asks the analyst to rank by importance, combine duplicate coverage,
avoid unsupported causal claims, identify thin evidence, and preserve source
boundaries. A persona lens replaces the generic style section rather than being
layered on top of conflicting defaults.

Digest calls use `budget.digest_model`, `digest_thinking_level`, and
`digest_max_turns`. Their usage is recorded separately in metrics and the cost
ledger.

## Selective article fetching

RSS snippets vary from full articles to titles only. Registry metadata guides
the model's `web_fetch` decisions:

- `fetch_hint: always` — fetch before making strong claims
- `fetch_hint: auto` — fetch when relevance or ambiguity justifies the cost
- `fetch_hint: never` — normally trust the supplied full text or skip fetching

`content_quality` explains why. Large digests add an explicit expectation to
fetch a small number of the most important or ambiguous thin items. Guidance is
prompt-level rather than a hard execution rule so the model can respond to the
actual item mix.

Fetched URLs are normalized and matched back to feed items for per-source
metrics. Tracking parameters are removed before comparison.

## Context and archives

After delivery, a structured extraction pass summarizes topics, entities,
sentiment, and interests served. `feed_context.json` retains the eight most
recent context entries so later digests can notice continuity without receiving
the entire archive.

The full digest text is appended to `digest_archive.json`, capped at 60 entries.
The archive supports weekly synthesis and is separate from the compact rolling
context.

## Digest quality evaluation

A low-cost structured evaluation runs after a successful digest. It scores:

- factual grounding
- analytical depth
- source use
- relevance to persona interests
- clarity and voice

The evaluator receives item metadata plus observed fetch behavior. It retries
once with a stricter schema prompt when output is malformed, and treats
placeholder, uniform, or oversized responses as suspicious rather than
silently accepting them.

Results are appended to `digest_quality.jsonl` and emitted as structured
events. Evaluation failure never blocks delivery of the digest itself.

## Source review

Quality evaluations feed `feed_source_review.json`, which maintains per-source
counts, quality averages, observed fetch rates, and recommendation confidence.
The current mode is advisory: sources may be labeled keep, review, or disable,
and fetch hints may be recommended, but the registry is not rewritten
automatically.

Low-confidence or suspicious evaluations are excluded from source-score
accumulation. Recommendations require repeated evidence so one unusual digest
does not condemn a source.

## Weekly synthesis

On `synthesis_day` at `synthesis_time`, an enabled agent considers digests from
the previous seven days. At least three recent digests are required. The
synthesis covers:

- trend and narrative-arc detection
- changes in entities and sentiment
- a prediction scorecard
- interest drift
- source quality and blind spots

The synthesis uses the configured digest model, posts to the feed channel, and
records `SynthesisMetrics` and ledger usage.

## Runtime artifacts

All feed artifacts live in the private persona directory:

| File | Purpose |
|---|---|
| `feeds.json` | source registry |
| `feeds_state.json` | next checks and seen IDs |
| `feeds_pending.json` | queued unseen items |
| `feed_context.json` | compact rolling context |
| `digest_archive.json` | recent full digests |
| `digest_quality.jsonl` | append-only evaluation history |
| `feed_source_review.json` | per-source advisory statistics |

State files are created by the process and should not be copied into public
examples or committed.

## Module boundaries

The public `feeds.ts` module keeps compatibility exports while implementation
is split by responsibility:

- `feeds.ts` — shared types, pending items, feed-check runner, and time helpers
- `feed-context.ts` — context, archive, interests, and lens loading
- `feed-digest.ts` — prompt construction, selection, delivery, and metrics
- `feed-fetch-guidance.ts` — registry metadata and fetch expectations
- `feed-monitor.ts` — scheduled polling, refresh, and delivery orchestration
- `feed-review.ts` — source-quality aggregation and recommendations
- `feed-synthesis.ts` — weekly prompt and execution
- `feed-wiring.ts` — path resolution and callbacks for heartbeat/manual actions

New options must be threaded through the monitor-cycle types, digest enqueue
path, scheduled delivery/refresh functions, heartbeat, and manual Discord
triggers. Tests should cover both immediate and batched delivery modes.

## Operations

The Discord commands `/digest` and `/refresh` allow manual delivery and forced
polling. `/replay` reposts the most recent digest held in memory. The dashboard
shows queue/source state, recent events, models, and cost.

For a source that repeatedly fails, inspect structured logs, run the feed
manager's status/check actions, and validate the URL outside the bot. Do not
delete state files while the process is writing them.
