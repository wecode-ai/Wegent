import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { balanceUnitTests } from "./balance-wework-unit-tests.mjs";

const evidence = JSON.parse(
  readFileSync(
    new URL("../ci/wework-unit-test-durations.json", import.meta.url),
  ),
);
const files = Object.keys(evidence.milliseconds);
const cost = (shard) =>
  shard.reduce(
    (sum, file) =>
      sum + evidence.milliseconds[file] + evidence.perFileOverheadMs,
    0,
  );

test("measured sharding retains every file once and improves the original hash partition", () => {
  const shards = [1, 2].map((index) => balanceUnitTests(files, index, 2));
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.deepEqual(balanceUnitTests([...files].reverse(), 1, 2), shards[0]);
  const original = [...files].sort((a, b) => {
    const hash = (file) => createHash("sha1").update(`/${file}`).digest("hex");
    return hash(a).localeCompare(hash(b));
  });
  const midpoint = Math.ceil(original.length / 2);
  assert.ok(
    Math.max(...shards.map(cost)) <
      Math.max(
        cost(original.slice(0, midpoint)),
        cost(original.slice(midpoint)),
      ),
  );
});

test("partial selections, new files and multiple shard counts preserve exact coverage", () => {
  for (const selection of [
    [],
    files.slice(0, 9),
    ["new.test.ts", ...files.slice(0, 7)],
  ]) {
    for (const count of [1, 2, 4]) {
      const result = Array.from({ length: count }, (_, index) =>
        balanceUnitTests(selection, index + 1, count),
      );
      assert.deepEqual(result.flat().sort(), [...selection].sort());
    }
  }
  assert.throws(() => balanceUnitTests(["a", "a"], 1, 2), /Duplicate/);
  assert.throws(() => balanceUnitTests(files, 0, 2), /Invalid/);
  assert.throws(
    () =>
      balanceUnitTests(["bad"], 1, 2, {
        milliseconds: { bad: NaN },
        perFileOverheadMs: 1,
      }),
    /Invalid/,
  );
});
