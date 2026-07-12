# Contributing to Newsteam

Thanks for helping improve Newsteam. Keep changes focused, explain the user
impact, and include tests for behavior changes.

## Development setup

```bash
npm ci
cp config.example.yaml config.yaml
npm run build
```

Active `config.yaml`, `.env`, logs, and `persona/` files are private runtime
artifacts. Do not commit them. Public persona examples belong under
`examples/personas/` and must be written from scratch.

## Tests

Run the full local verification before opening a pull request:

```bash
npm run build
npm test
python3 -m unittest tests/test_feed_check.py tests/test_feed_manage.py -v
```

Run `docker build -t newsteam .` when changing Docker or deployment behavior
and Docker is available. Mention any verification you could not perform.

## Code conventions

- Keep source files at or below 500 lines. Extract cohesive modules and retain
  compatibility exports when splitting a public module.
- Use ES modules and NodeNext module resolution.
- Use Node's built-in test runner and Python `unittest`; do not introduce Jest
  or Vitest for existing suites.
- Prefix commits with `feat:`, `fix:`, or `chore:`.
- Preserve the single-user Discord authorization boundary unless the change
  explicitly implements and tests a broader model.

## Tools

Tools are sandboxed Python or Node handlers described by JSON manifests. A
manifest defines the model-facing name, JSON Schema parameters, declared
secrets, timeout, handler, and runtime. The executor launches only that handler
with a minimal environment and wraps output as untrusted data.

Do not add general shell access or inject undeclared environment variables. See
[docs/DESIGN.md](docs/DESIGN.md) for the custom-tool guide and
[docs/SCHEMA.md](docs/SCHEMA.md) for the locally enforced schema subset.

## Pull requests

- Describe the problem and the chosen behavior.
- Add or update tests for behavior changes.
- Update public docs and `config.example.yaml` when configuration changes.
- Keep private identifiers, secrets, absolute local paths, and runtime persona
  content out of commits.
- Confirm the build and relevant TypeScript/Python tests pass.

For the architecture, feed option-threading pattern, and observability
contracts, read [AGENTS.md](AGENTS.md).
