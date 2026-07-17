import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PERSONA_ID,
  findPersona,
  isConfiguredApiKey,
  loadPersonaCatalog,
  resolvePersonaChoice,
} from "../src/onboarding.ts";

test("loadPersonaCatalog discovers complete public personas with descriptions", () => {
  const personas = loadPersonaCatalog(process.cwd());

  assert.equal(personas.length, 6);
  assert.deepEqual(
    personas.map((persona) => persona.id),
    [
      DEFAULT_PERSONA_ID,
      "the-analyst",
      "machiavelli",
      "the-general",
      "john-bogel",
      "deep-lurker",
    ],
  );
  assert.deepEqual(
    new Set(personas.map((persona) => persona.id)),
    new Set([
      "deep-lurker",
      "john-bogel",
      "kingclawd",
      "machiavelli",
      "the-analyst",
      "the-general",
    ]),
  );
  for (const persona of personas) {
    assert.ok(persona.name.length > 0);
    assert.ok(persona.description.length > 0);
  }
});

test("resolvePersonaChoice supports defaults, numbers, IDs, and names", () => {
  const personas = loadPersonaCatalog(process.cwd());

  assert.equal(resolvePersonaChoice(personas, "")?.id, "kingclawd");
  assert.equal(resolvePersonaChoice(personas, "2")?.id, personas[1]?.id);
  assert.equal(resolvePersonaChoice(personas, "the-analyst")?.id, "the-analyst");
  assert.equal(resolvePersonaChoice(personas, "The Analyst")?.id, "the-analyst");
  assert.equal(resolvePersonaChoice(personas, "999"), null);
  assert.equal(findPersona(personas, "missing"), null);
});

test("isConfiguredApiKey rejects missing and placeholder values", () => {
  assert.equal(isConfiguredApiKey(undefined), false);
  assert.equal(isConfiguredApiKey(""), false);
  assert.equal(isConfiguredApiKey("  your-google-api-key  "), false);
  assert.equal(isConfiguredApiKey("  configured-key  "), true);
});
