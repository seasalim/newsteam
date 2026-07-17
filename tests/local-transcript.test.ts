import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalTranscript, type LocalMessage } from "../src/local-transcript.ts";

function message(index: number): LocalMessage {
  return {
    id: `m_${String(index).padStart(6, "0")}`,
    channel_id: "agent/chat",
    role: "user",
    kind: "chat",
    text: `message ${index}`,
    ts: new Date(index).toISOString(),
  };
}

test("local transcript appends and pages history without path traversal", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-transcript-"));
  const transcript = new LocalTranscript([{ channelId: "agent/chat", personaDir }]);
  transcript.initialize();
  for (let index = 1; index <= 5; index += 1) transcript.append(message(index));

  assert.deepEqual(transcript.history("agent/chat", { n: 2 }).map((entry) => entry.text), [
    "message 4",
    "message 5",
  ]);
  assert.deepEqual(
    transcript.history("agent/chat", { before: "m_000004", n: 10 }).map((entry) => entry.text),
    ["message 1", "message 2", "message 3"],
  );
  assert.deepEqual(
    transcript.history("agent/chat", { after: "m_000003", n: 10 }).map((entry) => entry.text),
    ["message 4", "message 5"],
  );
  assert.ok(fs.existsSync(path.join(personaDir, "local_channel", "agent%2Fchat.jsonl")));
});

test("local transcript compacts files over 5000 lines to the newest 2000", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-transcript-"));
  const directory = path.join(personaDir, "local_channel");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, "chat.jsonl");
  fs.writeFileSync(
    filePath,
    `${Array.from({ length: 5_001 }, (_, index) => JSON.stringify({ ...message(index), channel_id: "chat" })).join("\n")}\n`,
  );

  const transcript = new LocalTranscript([{ channelId: "chat", personaDir }]);
  transcript.initialize();
  assert.equal(fs.readFileSync(filePath, "utf8").trim().split("\n").length, 2_000);
  assert.equal(transcript.history("chat", { n: 200 })[199]!.text, "message 5000");
});

test("local transcript SSE replay is not limited by the history page size", () => {
  const personaDir = mkdtempSync(path.join(tmpdir(), "newsteam-transcript-"));
  const transcript = new LocalTranscript([{ channelId: "agent/chat", personaDir }]);
  transcript.initialize();
  for (let index = 1; index <= 250; index += 1) transcript.append(message(index));
  assert.equal(transcript.allAfter("m_000000").length, 250);
});
