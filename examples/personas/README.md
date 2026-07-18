# Example Personas

These personas demonstrate how the same feed pipeline can produce very
different analysis. Each combines a distinct voice with an explicit set of
interests, an analytical lens, and a starter feed registry. The personality
can be playful or severe, but the underlying guidance is designed to remain
useful when the stylistic layer is removed.

## Available personas

| Avatar | Persona | Character | Focus |
| --- | --- | --- | --- |
| <img src="./kingclawd/PROFILE.png" width="72" alt="King Clawd profile"> | `kingclawd` | A witty, opinionated lobster monarch surveying the information reef | AI agents, capabilities, alignment, research, and the agent economy |
| <img src="./the-analyst/PROFILE.png" width="72" alt="The Analyst profile"> | `the-analyst` | A restrained researcher with a spreadsheet and a red pen | AI economics, technology markets, infrastructure, evidence quality, and incentives |
| <img src="./machiavelli/PROFILE.png" width="72" alt="Machiavelli profile"> | `machiavelli` | A sardonic political strategist who follows power rather than press releases | US politics, elections, institutions, geopolitics, and strategic incentives |
| <img src="./the-general/PROFILE.png" width="72" alt="The General profile"> | `the-general` | A sober military-intelligence briefer tracking the escalation ladder | The US-Israel-Iran conflict, Gulf security, UAE strategy, energy, and shipping |
| <img src="./john-bogel/PROFILE.png" width="72" alt="John Bogel profile"> | `john-bogel` | A plainspoken investing elder who distrusts hype, complexity, and fees | Index investing, asset allocation, retirement planning, taxes, and investor behavior |
| <img src="./deep-lurker/PROFILE.png" width="72" alt="Deep Lurker profile"> | `deep-lurker` | A veteran Reddit observer separating community signal from engagement noise | Technology, cybersecurity, finance, travel, gaming, and movies |

## Use an example

Copy a persona into the private runtime directory:

```bash
mkdir -p persona
cp -r examples/personas/kingclawd persona/kingclawd
```

Replace `kingclawd` with any persona name from the table. Add the matching
agent entry to `config.yaml`, set its Discord channel IDs, and restart
NewsTeam. The `persona_dir` should point to the copied directory, for example
`persona/kingclawd`.

## What each file controls

- `IDENTITY.md` defines the agent's durable personality, purpose, and voice.
- `INTERESTS.md` ranks the domains the digest should prioritize.
- `LENS.md` supplies the analytical framework and digest-writing rules.
- `feeds.json` registers RSS sources and gives the agent fetch guidance.
- `PROFILE.png` optionally supplies the persona image used by Local Chat and
  Mission Control. Use a square PNG between 32px and 4096px; 512px is the
  recommended single source size, with the subject centered for circular
  cropping. Missing or invalid images fall back to the persona's initial.

The examples intentionally omit `MEMORY.md` and runtime feed artifacts.
Agents create and maintain `MEMORY.md`, `feeds_state.json`,
`feeds_pending.json`, `feed_context.json`, `digest_archive.json`,
`digest_quality.jsonl`, and `feed_source_review.json` as needed while running.
Keep the active `persona/` directory private; it is ignored by Git.
Shared security guardrails are injected by NewsTeam and therefore do not need
to be duplicated in each `IDENTITY.md`.
