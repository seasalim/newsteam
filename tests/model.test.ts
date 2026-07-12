import assert from "node:assert/strict";
import test from "node:test";

import {
  getModelProvider,
  stripProviderPrefix,
  validateMatchingModelProviders,
} from "../src/model.ts";

test("OpenAI model prefixes select the OpenAI provider", () => {
  assert.equal(getModelProvider("openai/gpt-5.4-mini"), "openai");
  assert.equal(stripProviderPrefix("openai/gpt-5.4-mini"), "gpt-5.4-mini");
  assert.doesNotThrow(() => validateMatchingModelProviders(
    "openai/gpt-5.4-mini",
    "openai/gpt-5.6-sol",
    "config.defaults.budget",
  ));
});

test("OpenAI and non-OpenAI model prefixes cannot be mixed", () => {
  assert.throws(() => validateMatchingModelProviders(
    "openai/gpt-5.4-mini",
    "google/gemini-3-flash",
    "config.defaults.budget",
  ), {
    message: "config.defaults.budget.digest_model must use the same provider as config.defaults.budget.model",
  });
});
