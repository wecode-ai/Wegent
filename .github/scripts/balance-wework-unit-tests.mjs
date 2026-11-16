import { readFileSync } from "node:fs";

const measurements = JSON.parse(
  readFileSync(
    new URL("../ci/wework-unit-test-durations.json", import.meta.url),
  ),
);

export function balanceUnitTests(files, index, count, evidence = measurements) {
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  ) {
    throw new Error("Invalid unit test shard");
  }
  if (new Set(files).size !== files.length)
    throw new Error("Duplicate unit test file");
  const samples = Object.values(evidence.milliseconds).sort((a, b) => a - b);
  const unmeasuredCost = samples[Math.floor(samples.length / 2)] ?? 0;
  const cost = (file) =>
    (evidence.milliseconds[file] ?? unmeasuredCost) +
    evidence.perFileOverheadMs;
  for (const file of files) {
    if (!Number.isFinite(cost(file)) || cost(file) <= 0)
      throw new Error(`Invalid test duration: ${file}`);
  }
  const shards = Array.from({ length: count }, () => ({ files: [], cost: 0 }));
  const ordered = [...files].sort(
    (a, b) => cost(b) - cost(a) || a.localeCompare(b),
  );
  for (const file of ordered) {
    const shard = shards.reduce((best, candidate) =>
      candidate.cost < best.cost ? candidate : best,
    );
    shard.files.push(file);
    shard.cost += cost(file);
  }
  return shards[index - 1].files;
}
