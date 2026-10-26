import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "wework-executor-debugger-"));
try {
  const executor = join(directory, "executor");
  const wrapper = `${executor}.gdb`;
  // Renaming a host multicall binary can change its dispatch instead of echoing arguments.
  writeFileSync(executor, '#!/bin/sh\nprintf "$@"\n', { mode: 0o755 });
  copyFileSync(
    new URL("./run-wework-executor-with-gdb.sh", import.meta.url),
    wrapper,
  );
  const result = spawnSync(
    "bash",
    [wrapper, "%s\n", "--workbench-schema", "--version"],
    {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.equal(result.stdout, "--workbench-schema\n--version\n");
  assert.equal(result.stderr, "");
  console.log(
    "Executor debugger preserves schema queries with a scrubbed environment",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
