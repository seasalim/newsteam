# NewsTeam 🦞

[![CI](https://github.com/seasalim/newsteam/actions/workflows/ci.yml/badge.svg)](https://github.com/seasalim/newsteam/actions/workflows/ci.yml)

> **Your personal, self-hosted news team.**

NewsTeam is a free, self-hosted team of AI news analysts with a built-in browser chat or optional Discord delivery. They read the RSS feeds you choose, post opinionated digests on your schedule, grade their sources, produce a weekly synthesis, and stay within hard spending limits.

Each analyst has a distinct personality and point of view, so the result feels less like a generic summary and more like a briefing from someone whose judgment you understand.

**Free to start · Self-hosted · Hard spending caps · Open source**

## Start for $0

The recommended setup uses the Gemini free tier and does not require a billing account.

Get an API key from [Google AI Studio](https://aistudio.google.com) without attaching billing. The default `google/gemini-3-flash-preview` model supports the free tier. It is enough to try NewsTeam and can support a light digest schedule. Tool calls, follow-ups, background evaluation, and additional agents use more requests, so heavier use may require paid capacity. [Rate limits](https://ai.google.dev/gemini-api/docs/rate-limits) vary by project and region.

### Need more capacity?

Paid capacity is optional. Enable billing only if you outgrow the Gemini free tier; NewsTeam records model-specific usage and enforces hard per-session cost caps. One real-world paid-tier run costs roughly **$0.10/day for three digests delivered twice daily on `google/gemini-3-flash-preview`**. Actual cost depends on feed volume, digest frequency, and how often an analyst fetches full articles.

## Quickstart: try it locally

The demo lets you choose from six analyst personas, starts browser chat at `http://127.0.0.1:7777/chat`, and generates a real briefing from that persona's starter feeds. It needs no Discord bot, channel IDs, or `config.yaml`. You will need Docker with Docker Compose installed.

```bash
git clone https://github.com/seasalim/newsteam.git
cd newsteam
docker compose run --build --rm --service-ports demo
```

If `GOOGLE_API_KEY` is blank, NewsTeam points you to Google AI Studio and prompts for the key without displaying it. The entered key stays in memory for that run only; add it to `.env` to skip the prompt later. NewsTeam then presents each persona with a one-line description so you can choose the briefing style.

The demo reads the selected persona's real starter feeds. Chat, entered keys, demo memory, and feed state are discarded when the process exits. If the browser does not open automatically, use the printed URL.

Already have Node.js 22+ and Python 3 installed? Run `npm ci && npm run demo` instead.

## Features

- **Analyst personas.** Each analyst is a character you define — its own voice (`IDENTITY.md`), ranked interests (`INTERESTS.md`), and analytical lens (`LENS.md`) — so digests read like opinionated commentary from someone with a worldview, not neutral summaries.
- **Chat with your analysts.** Use the built-in local browser UI or Discord to ask follow-ups, debate a take, or dig into a source. Both paths are single-user, rate-limited, and budget-capped.
- **Slash commands.** `/digest` and `/refresh` trigger deliveries on demand, `/replay` re-posts the last digest, `/cost` shows the day and month ledger, `/stats`, `/health`, and `/new` cover session stats, system status, and starting a fresh conversation.
- **Two-layer digest pipeline.** Detects new RSS/Atom items and burns zero model tokens when nothing has changed; the LLM narrates only new items.
- **Weekly synthesis.** Analysts connect trends across daily digests, revisit predictions, track narrative arcs, and surface interest drift.
- **Budget tracker and cost ledger.** Token usage, tool calls, and model-specific costs are recorded with hard per-session limits.
- **Sandboxed tool system.** Capability-based tools have JSON manifests, no shell access, declared secrets, timeouts, schema validation, and outputs wrapped as untrusted data.
- **Split model strategy.** Use a cheap model for chat and a deeper model for digests, with Anthropic, Gemini, and OpenAI providers supported per agent.
- **Memory.** Each persona keeps a small, bounded, agent-managed memory file.
- **Local chat and dashboard.** Browser chat lives at `http://127.0.0.1:7777/chat`; mission control reports agents, feeds, activity, and spend at `http://127.0.0.1:7777`.

NewsTeam is roughly 8,000 lines of code, has minimal dependencies, uses no agent framework, and has a deliberately small tool set, making it easy to inspect and inexpensive to run.

## Keep it running locally

For scheduled briefings and persistent browser chat, copy the configuration and a persona, then select the local provider. You need the same free [Google AI Studio](https://aistudio.google.com) API key.

```bash
cp .env.example .env
cp config.example.yaml config.yaml
mkdir -p persona logs
cp -r examples/personas/kingclawd persona/kingclawd
```

Add `GOOGLE_API_KEY` to `.env`. The copied configuration already selects local browser chat with readable channel slugs, so you can start NewsTeam directly:

```bash
docker compose up -d --build
docker compose logs -f newsteam
```

Open `http://127.0.0.1:7777/chat` and run `/refresh` to generate the first digest. Scheduled digests continue from there, and display transcripts persist under each private persona directory.

### Optional: use Discord

Change `channel.provider` to `discord`, uncomment the `discord` block, add `DISCORD_TOKEN` to `.env`, and replace the channel slugs with Discord channel IDs.

### How to get your Discord IDs

In Discord, enable **User Settings → Advanced → Developer Mode**. Right-click your user and choose **Copy User ID** for `allowed_user_id`; right-click each destination channel and choose **Copy Channel ID** for `channel_ids` and `feeds.channel_id`. Create a bot in the Discord Developer Portal, enable the Message Content intent, invite it to the server with permission to view and send messages, and put its token in `.env`.

See [Deployment](docs/DEPLOY.md) for local-channel security, Linux, macOS, Windows/WSL, logs, updates, and lifecycle commands.

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
