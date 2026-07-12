import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function fail(error, message) {
  respond({ error, matches: [], count: 0, message });
}

function main() {
  let args;
  try {
    args = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    fail("invalid_input", "Recall requires a valid JSON request.");
    return;
  }

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    fail("missing_query", "query is required for recall.");
    return;
  }

  const personaDir = process.env.NEWSTEAM_PERSONA_DIR?.trim();
  if (!personaDir) {
    fail(
      "missing_tool_context",
      "Memory path was not provided by the Newsteam runtime.",
    );
    return;
  }

  const memoryPath = path.resolve(personaDir, "MEMORY.md");
  if (!existsSync(memoryPath)) {
    respond({ matches: [], count: 0, message: "No memories stored yet." });
    return;
  }

  const lowerQuery = query.toLowerCase();
  const matches = readFileSync(memoryPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2))
    .filter((line) => line.toLowerCase().includes(lowerQuery));

  respond({
    matches,
    count: matches.length,
    message: matches.length === 0
      ? "No matching memories found."
      : `Found ${matches.length} matching memor${matches.length === 1 ? "y" : "ies"}.`,
  });
}

main();
