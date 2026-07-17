import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

import {
  renderTerminalMarkdown,
  terminalColorsEnabled,
} from "../src/terminal-markdown.ts";

test("renders common digest Markdown with terminal styling", () => {
  const output = renderTerminalMarkdown([
    "## Reef Report",
    "",
    "**Important** signal with *some context* and `code`.",
    "",
    "- First item",
    "- [Source](https://example.com/story)",
    "1. Watch this",
  ].join("\n"), { isTTY: true, colors: true });
  const visible = stripVTControlCharacters(output);

  assert.match(output, /\u001b\[/u);
  assert.doesNotMatch(visible, /## Reef Report/u);
  assert.doesNotMatch(visible, /\*\*Important\*\*/u);
  assert.match(visible, /Reef Report/u);
  assert.match(visible, /• First item/u);
  assert.match(visible, /Source/u);
  assert.match(visible, /https:\/\/example\.com\/story/u);
  assert.match(visible, /1\. Watch this/u);
});

test("renders readable plain text when colors are disabled", () => {
  const output = renderTerminalMarkdown(
    "# Briefing\n\n> **Careful:** thin sourcing.\n\n[Read more](https://example.com)",
    { isTTY: true, colors: false },
  );

  assert.equal(
    output,
    "Briefing\n\n│ Careful: thin sourcing.\n\nRead more (https://example.com)",
  );
  assert.doesNotMatch(output, /\u001b/u);
});

test("preserves fenced code contents without interpreting inline Markdown", () => {
  const output = renderTerminalMarkdown(
    "```ts\nconst marker = \"**literal**\";\n```",
    { isTTY: true, colors: false },
  );

  assert.equal(output, "  const marker = \"**literal**\";");
});

test("preserves sanitized Markdown for redirected output", () => {
  const output = renderTerminalMarkdown(
    "## Briefing\n\u001b[31m**Alert**\u001b[0m",
    { isTTY: false },
  );

  assert.equal(output, "## Briefing\n**Alert**");
});

test("strips unsafe control characters before rendering", () => {
  const output = renderTerminalMarkdown(
    "Safe\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007\u202Etext",
    { isTTY: true, colors: false },
  );

  assert.equal(output, "Safelinktext");
});

test("leaves malformed and unsupported Markdown readable", () => {
  const output = renderTerminalMarkdown(
    "An **unfinished thought\n| table | stays |",
    { isTTY: true, colors: false },
  );

  assert.equal(output, "An **unfinished thought\n| table | stays |");
});

test("terminalColorsEnabled respects NO_COLOR and dumb terminals", () => {
  assert.equal(terminalColorsEnabled({ TERM: "xterm-256color" }), true);
  assert.equal(terminalColorsEnabled({ TERM: "xterm-256color", NO_COLOR: "" }), false);
  assert.equal(terminalColorsEnabled({ TERM: "dumb" }), false);
});
