# NewsTeam 🦞

[![CI](https://github.com/seasalim/newsteam/actions/workflows/ci.yml/badge.svg)](https://github.com/seasalim/newsteam/actions/workflows/ci.yml)

> **Your personal news team. No subscription. Start for $0.**

NewsTeam is a free, self-hosted team of AI news analysts for Discord. They read the RSS feeds you choose, post opinionated digests on your schedule, grade their sources, produce a weekly synthesis, and stay within hard spending limits.

Each analyst has a distinct personality and point of view, so the result feels less like a generic summary and more like a briefing from someone whose judgment you understand.

**Free to start · Self-hosted · Hard spending caps · Open source**

## Start for $0

The recommended setup uses the Gemini free tier and does not require a billing account.

Get an API key from [Google AI Studio](https://aistudio.google.com) without attaching billing. The default `google/gemini-3-flash-preview` model in `config.example.yaml` supports the free tier, whose limits are enough for a typical NewsTeam digest schedule. Availability and [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) vary by account and region.

### Need more capacity?

Paid capacity is optional. Enable billing only if you outgrow the Gemini free tier; NewsTeam records model-specific usage and enforces hard per-session cost caps. One real-world paid-tier run costs roughly **$0.10/day for three digests delivered twice daily on `google/gemini-3-flash-preview`**. Actual cost depends on feed volume, digest frequency, and how often an analyst fetches full articles.

## Features

- **Analyst personas.** Each analyst is a character you define — its own voice (`IDENTITY.md`), ranked interests (`INTERESTS.md`), and analytical lens (`LENS.md`) — so digests read like opinionated commentary from someone with a worldview, not neutral summaries.
- **Chat with your analysts.** Talk to each persona in its Discord channel — ask follow-ups on a digest, debate a take, or dig into a source. Locked to your user ID, rate-limited, and budget-capped, so conversations never run up the bill.
- **Slash commands.** `/digest` and `/refresh` trigger deliveries on demand, `/replay` re-posts the last digest, `/cost` shows the day and month ledger, `/stats`, `/health`, and `/new` cover session stats, system status, and starting a fresh conversation.
- **Two-layer digest pipeline.** Detects new RSS/Atom items and burns zero model tokens when nothing has changed; the LLM narrates only new items.
- **Weekly synthesis.** Analysts connect trends across daily digests, revisit predictions, track narrative arcs, and surface interest drift.
- **Budget tracker and cost ledger.** Token usage, tool calls, and model-specific costs are recorded with hard per-session limits.
- **Sandboxed tool system.** Capability-based tools have JSON manifests, no shell access, declared secrets, timeouts, schema validation, and outputs wrapped as untrusted data.
- **Split model strategy.** Use a cheap model for chat and a deeper model for digests, with Anthropic, Gemini, and OpenAI providers supported per agent.
- **Memory.** Each persona keeps a small, bounded, agent-managed memory file.
- **Dashboard.** Local mission control reports agents, feeds, activity, and spend at `http://127.0.0.1:7777`.

NewsTeam is roughly 8,000 lines of code, has minimal dependencies, uses no agent framework, and has a deliberately small tool set, making it easy to inspect and inexpensive to run.

## Quickstart (Docker)

**Free setup:** Docker, a Discord bot token, and a [Google AI Studio](https://aistudio.google.com) API key with billing disabled.

```bash
git clone https://github.com/seasalim/newsteam.git
cd newsteam
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p persona logs
cp -r examples/personas/kingclawd persona/kingclawd
```

Fill in `.env`, replace the Discord placeholders in `config.yaml`, then start the bot:

```bash
docker compose up -d --build
docker compose logs -f newsteam
```

Once the bot is online, run `/refresh` in its Discord channel to fetch the starter feeds and generate your first digest immediately. Scheduled digests continue from there.

### How to get your Discord IDs

In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your user and choose **Copy User ID** for `allowed_user_id`; right-click each destination channel and choose **Copy Channel ID** for `channel_ids` and `feeds.channel_id`. Create a bot in the Discord Developer Portal, enable the Message Content intent, invite it to the server with permission to view and send messages, and put its token in `.env`.

The bot should be running in about ten minutes. See [Deployment](docs/DEPLOY.md) for Linux, macOS, Windows/WSL, logs, updates, and lifecycle commands.

## Personas

Each active persona lives in `persona/<agent>/` and is private to the deployment:

- `IDENTITY.md` defines personality and voice.
- `INTERESTS.md` ranks domains by importance.
- `LENS.md` defines the analytical framework and digest style.
- `feeds.json` registers RSS sources and fetch guidance.

NewsTeam creates memory and feed-state artifacts at runtime. Start with [KingClawd or The Analyst](examples/personas/README.md), then edit the files to make the analyst yours.

## Deploying

Docker is recommended. Linux systemd and macOS launchd instructions are in [docs/DEPLOY.md](docs/DEPLOY.md).

## License

[MIT](LICENSE)
