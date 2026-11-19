import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { coreRunnerSlots } from "./core-runner-slots.mjs";

import { expandDesktopCheckpoints } from "../../wework/e2e/desktop/checkpoints.mjs";
import { loadDesktopCheckpointCatalog } from "../../wework/e2e/desktop/checkpoint-catalog.mjs";

const measurements = JSON.parse(
  readFileSync(
    new URL("../ci/wework-windows-checkpoint-durations.json", import.meta.url),
  ),
);
const fullCoreCheckpoints = expandDesktopCheckpoints(
  loadDesktopCheckpointCatalog().ci.core_segments,
);

const preparationGroups = {
  "local-harness": [
    "claude-runtime",
    "local-harness",
    "workbench-mode",
    "native-window-startup",
  ],
  "dingtalk-protocol-fixture": [
    "stand-in-identities",
    "stand-in-connections",
    "stand-in-cli",
  ],
};

function preparationTasks(checkpoints) {
  const pending = new Map(
    checkpoints.map((checkpoint) => [checkpoint.segment, checkpoint]),
  );
  const tasks = [];
  // These checkpoints shared expensive preparation in the original Core matrix.
  for (const [preparation, group] of Object.entries(preparationGroups)) {
    const members = group
      .map((segment) => pending.get(segment))
      .filter(Boolean);
    if (!members.length) continue;
    tasks.push({
      segments: members.map((checkpoint) => checkpoint.segment),
      seconds: members.reduce(
        (total, checkpoint) => total + checkpoint.seconds,
        measurements.preparationSeconds[preparation],
      ),
    });
    for (const checkpoint of members) pending.delete(checkpoint.segment);
  }
  for (const checkpoint of pending.values()) {
    tasks.push({ segments: [checkpoint.segment], seconds: checkpoint.seconds });
  }
  return tasks.sort(
    (a, b) =>
      b.seconds - a.seconds || a.segments[0].localeCompare(b.segments[0]),
  );
}

export function checkpointSeconds(segment, seconds = measurements.seconds) {
  const checkpoints = expandDesktopCheckpoints([segment]);
  if (checkpoints.some((checkpoint) => seconds[checkpoint] === undefined))
    return null;
  return checkpoints.reduce(
    (total, checkpoint) => total + seconds[checkpoint],
    0,
  );
}

function assignTask(shard, task) {
  shard.segments.push(...task.segments);
  shard.seconds += task.seconds;
}

function leastLoaded(shards) {
  return shards.reduce((best, shard) =>
    shard.seconds < best.seconds ? shard : best,
  );
}

function balanceMeasuredWork(shards, ordinary, unmeasured, checkpoints) {
  const origins = new Map(
    checkpoints.map((checkpoint) => [checkpoint.segment, checkpoint.origin]),
  );
  const durations = new Map(
    checkpoints.map((checkpoint) => [checkpoint.segment, checkpoint.seconds]),
  );
  const placements = [];
  for (const task of preparationTasks(checkpoints)) {
    const source = shards.find(
      (shard) =>
        unmeasured.has(shard.id) &&
        task.segments.every((segment) => origins.get(segment) === shard.id),
    );
    const target = source ?? leastLoaded(ordinary);
    assignTask(target, task);
    placements.push({ source: target, origin: source, task });
  }
  const active = [
    ...new Set([...ordinary, ...placements.map((entry) => entry.source)]),
  ];
  const knownLoad = (shard) =>
    shard.segments.reduce(
      (total, segment) => total + (durations.get(segment) ?? 0),
      0,
    );
  let moved;
  do {
    moved = false;
    for (const placement of placements) {
      const { source, origin, task } = placement;
      const target = leastLoaded(origin ? [...ordinary, origin] : ordinary);
      const knownCost = task.segments.reduce(
        (total, segment) => total + durations.get(segment),
        0,
      );
      // Every move lowers the affected peak and preserves the known global peak.
      // Unknown runners may only recover their own original measured work.
      if (
        target === source ||
        target.seconds + task.seconds >= source.seconds ||
        knownLoad(target) + knownCost > Math.max(...active.map(knownLoad))
      )
        continue;
      source.segments = source.segments.filter(
        (segment) => !task.segments.includes(segment),
      );
      source.seconds -= task.seconds;
      assignTask(target, task);
      placement.source = target;
      moved = true;
    }
  } while (moved);
}

function balanceShards(
  matrix,
  seconds,
  additionalRunners = 0,
  runnerScale = 1,
) {
  // Preserve the two exclusive benchmark shards and unknown-work ownership.
  const fixed = new Set(["core-9", "core-10"]);
  const unmeasured = new Set();
  const preparationSegments = new Set(Object.values(preparationGroups).flat());
  for (const entry of matrix.include) {
    const unknown = entry.segments
      .split(",")
      .filter((segment) => checkpointSeconds(segment, seconds) === null);
    if (!unknown.length) continue;
    // Do not split a preparation group when one member's cost is unknown.
    if (unknown.some((segment) => preparationSegments.has(segment)))
      fixed.add(entry.id);
    else unmeasured.add(entry.id);
  }
  const taskCount = matrix.include.reduce(
    (count, entry) =>
      count + (fixed.has(entry.id) ? 1 : entry.segments.split(",").length),
    0,
  );
  const entries = [
    ...matrix.include,
    ...coreRunnerSlots(matrix.include, taskCount, runnerScale),
  ];
  const shards = entries.map((entry) => ({
    ...entry,
    segments: [],
    seconds: 0,
  }));
  // Never add new measured work to a shard whose remaining cost is unknown.
  const ordinary = shards.filter(
    (entry) => !fixed.has(entry.id) && !unmeasured.has(entry.id),
  );
  if (ordinary.length) {
    const lastId = Math.max(
      ...shards.map((shard) => Number(shard.id.match(/-(\d+)$/)?.[1]) || 0),
    );
    for (let index = 1; index <= additionalRunners; index++) {
      const extra = {
        ...ordinary[0],
        id: `core-${lastId + index}`,
        name: `Core / shard ${lastId + index}`,
        segments: [],
        seconds: 0,
      };
      shards.push(extra);
      ordinary.push(extra);
    }
  }
  if (!ordinary.length) {
    // A partial selection with no measured destination retains its original work.
    for (const id of unmeasured) fixed.add(id);
  }
  const pending = [];
  const seen = new Set();
  for (const [index, entry] of matrix.include.entries()) {
    for (const segment of entry.segments.split(",")) {
      if (seen.has(segment))
        throw new Error(`Duplicate Windows Core segment: ${segment}`);
      seen.add(segment);
      const duration = checkpointSeconds(segment, seconds);
      if (fixed.has(entry.id) || duration === null) {
        shards[index].segments.push(segment);
        shards[index].seconds += duration ?? 0;
      } else {
        pending.push({ segment, seconds: duration, origin: entry.id });
      }
    }
  }
  balanceMeasuredWork(shards, ordinary, unmeasured, pending);
  return {
    shards,
    movablePeak: Math.max(0, ...ordinary.map((shard) => shard.seconds)),
  };
}

export function balanceWindowsMatrix(
  matrix,
  seconds = measurements.seconds,
  runnerScale = 1,
) {
  let result = balanceShards(matrix, seconds, 0, runnerScale);
  const capacity =
    measurements.processDeadlineSeconds - measurements.runnerOverheadSeconds;
  // One extra shared runner is authorized when measured work cannot fit the deadline.
  // A single oversized task cannot justify another runner that cannot resolve it.
  const selected = new Set(
    matrix.include.flatMap((shard) =>
      expandDesktopCheckpoints(shard.segments.split(",")),
    ),
  );
  if (
    fullCoreCheckpoints.every((checkpoint) => selected.has(checkpoint)) &&
    result.movablePeak >= capacity
  ) {
    const expanded = balanceShards(matrix, seconds, 1, runnerScale);
    if (expanded.movablePeak < capacity) result = expanded;
  }
  return {
    include: result.shards
      .filter((shard) => shard.segments.length)
      .map(({ seconds: _, ...entry }) => ({
        ...entry,
        segments: entry.segments.join(","),
      })),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const matrix = balanceWindowsMatrix(
    JSON.parse(process.env.CORE_MATRIX),
    measurements.seconds,
    Number(process.env.CORE_RUNNER_SCALE ?? 1),
  );
  console.log(`matrix=${JSON.stringify(matrix)}`);
}
