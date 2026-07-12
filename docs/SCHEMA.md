# Tool Manifest Schemas

Every external tool is described by `tools/<tool>/manifest.json`. The manifest
is both the startup contract for the executor and the model-visible tool
definition.

## Manifest shape

```json
{
  "name": "example_tool",
  "description": "Explain when the model should use this tool.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": {
        "type": "string",
        "description": "What to look up"
      },
      "count": {
        "type": "number",
        "description": "Maximum results"
      }
    },
    "required": ["query"]
  },
  "secrets": [],
  "timeout_ms": 5000,
  "handler": "handler.py",
  "runtime": "python"
}
```

Required top-level fields are `name`, `description`, `parameters`, `secrets`,
`timeout_ms`, `handler`, and `runtime`. Optional hardening fields are:

- `requires_confirmation` — require an interactive approval before execution
- `output_schema` — describe expected JSON output for basic validation
- `max_calls_per_hour` — process-local rate limit for the tool

## Argument validation

The current registry intentionally validates a small JSON Schema subset:

- top-level `required` fields
- property `type` values of `string` and `number`
- property `enum` allowlists

Unknown properties are currently passed through. Other JSON Schema keywords
may be useful to a model provider but are not enforcement boundaries in the
local registry. Do not rely on unsupported keywords for security or correctness.

For a tool with several actions, define one `action` string property with an
`enum`, make `action` required, and validate action-specific combinations in the
handler. Keep handler errors concise so the model can correct its next call.

## Provider handling

`ToolRegistry.getToolSchemas()` passes `parameters` to the neutral LLM request.
Provider adapters translate that request into their native tool format. The
manifest remains the source of truth; do not maintain a second schema in agent
code.

## Output contract

Handlers read one JSON object from standard input. They write their result to
standard output and diagnostics to standard error. A nonzero exit code marks
the call as failed. Keep output bounded and return JSON when an `output_schema`
is declared.

The executor wraps successful output as untrusted external data before giving
it to the model. Declared secret values are redacted from captured output and
errors.

## Testing a schema

Add registry tests for required fields, types, enum values, and optional
hardening behavior. Tool-specific tests should execute the handler with valid
and invalid JSON. Run:

```bash
npm test
python3 -m unittest tests/test_feed_manage.py -v
```
