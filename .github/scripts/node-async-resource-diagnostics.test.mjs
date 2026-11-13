import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { startAsyncResourceDiagnostics } from "./node-async-resource-diagnostics.mjs";

test("captures real worker filesystem timing without recording paths or contents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "node-async-diagnostics-"));
  const output = join(directory, "timing.jsonl");
  const secretPath = join(directory, "private-file-name.txt");
  const stop = startAsyncResourceDiagnostics(output, 1000, 0);
  try {
    await writeFile(secretPath, "private-body-must-not-appear");
    assert.equal(
      await readFile(secretPath, "utf8"),
      "private-body-must-not-appear",
    );
    await setImmediate();
  } finally {
    stop();
  }
  try {
    const text = await readFile(output, "utf8");
    const records = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      records.some(
        (record) => record.event === "filesystem" && record.durationMs >= 0,
      ),
    );
    assert.ok(
      records.some((record) => record.phase === "end" && record.cpuUserMs >= 0),
    );
    assert.doesNotMatch(text, /private-file-name|private-body-must-not-appear/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
