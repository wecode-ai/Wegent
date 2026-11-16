import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { coreRunnerSlots } from './core-runner-slots.mjs'

import {
  DESKTOP_CHECKPOINTS,
  expandDesktopCheckpoints,
} from '../../wework/e2e/desktop/checkpoints.mjs'
import {
  LINUX_CORE_HISTORY_CHECKPOINT,
  isResourceExclusiveCheckpoint,
} from '../../wework/e2e/desktop/checkpoint-scheduler.mjs'

const measurements = JSON.parse(
  readFileSync(
    new URL('../ci/wework-linux-checkpoint-durations.json', import.meta.url),
    'utf8',
  ),
)

export function balanceLinuxCoreMatrix(
  matrix,
  seconds = measurements.scopes.core,
  runnerScale = 1,
) {
  if (!Array.isArray(matrix?.include))
    throw new Error('Invalid Linux Core matrix')
  const include = matrix.include.map((entry) => ({ ...entry }))
  const history = include.find((entry) =>
    entry.segments.split(',').includes(LINUX_CORE_HISTORY_CHECKPOINT),
  )
  if (!history) return { ...matrix, include }
  const checkpoints = (entry) =>
    expandDesktopCheckpoints(entry.segments.split(','))
  const before = include.flatMap(checkpoints).sort()
  const taskCount = include.reduce(
    (total, entry) => total + (['core-9', 'core-10'].includes(entry.id)
      ? 1 : checkpoints(entry).length),
    0,
  )
  include.push(...coreRunnerSlots(include, taskCount, runnerScale))
  // Keep the two latency benchmark shards exclusive.
  const receivers = include.filter(
    (entry) => !['core-9', 'core-10'].includes(entry.id),
  )
  if (!receivers.some((entry) => entry !== history))
    return { ...matrix, include }
  if (new Set(before).size !== before.length)
    throw new Error('Overlapping Linux Core checkpoints')
  const pending = receivers
    .filter((entry) => entry.segments.length)
    .flatMap(checkpoints)
    .filter((checkpoint) => checkpoint !== LINUX_CORE_HISTORY_CHECKPOINT)
    .sort((a, b) => a.localeCompare(b))
  const ordered = orderLinuxCheckpoints(pending, 'core', seconds)
  const historySeconds = seconds[LINUX_CORE_HISTORY_CHECKPOINT]
  // History reserves every worker until it exits. Its remaining runner time
  // can serve measured ordinary checkpoints without sharing its runtime.
  const assignments = receivers.map((entry) => ({
    entry,
    checkpoints: entry === history ? [LINUX_CORE_HISTORY_CHECKPOINT] : [],
    workers: Array(measurements.workers).fill(
      entry === history ? (historySeconds ?? 180) : 0,
    ),
  }))
  // Exclusive checkpoints precede the worker queue and occupy the whole runner.
  // Add their duration to every worker, retaining the same runtime isolation.
  for (const checkpoint of ordered) {
    const exclusive = isResourceExclusiveCheckpoint(checkpoint, true)
    const load = (assignment) =>
      exclusive
        ? Math.max(...assignment.workers)
        : Math.min(...assignment.workers)
    // Do not put another exclusive prefix or an unmeasured case on history's runner.
    const candidates = assignments.filter(
      ({ entry }) =>
        entry !== history ||
        (!exclusive &&
          historySeconds !== undefined &&
          seconds[checkpoint] !== undefined),
    )
    candidates.sort(
      (a, b) =>
        load(a) - load(b) ||
        a.workers.reduce((sum, value) => sum + value, 0) -
          b.workers.reduce((sum, value) => sum + value, 0) ||
        a.entry.id.localeCompare(b.entry.id),
    )
    const target = candidates[0]
    const worker = target.workers.indexOf(Math.min(...target.workers))
    const duration = seconds[checkpoint] ?? 180
    if (exclusive)
      target.workers = target.workers.map((value) => value + duration)
    else target.workers[worker] += duration
    target.checkpoints.push(checkpoint)
  }
  for (const { entry, checkpoints: selected } of assignments) {
    if (!selected.length)
      throw new Error('Cannot leave a Linux Core runner empty')
    entry.segments = selected.join(',')
  }
  if (
    JSON.stringify(include.flatMap(checkpoints).sort()) !==
    JSON.stringify(before)
  ) {
    throw new Error('Linux Core checkpoint coverage changed')
  }
  return { ...matrix, include }
}

export function orderLinuxCheckpoints(
  segments,
  scope,
  seconds = measurements.scopes[scope],
) {
  if (!['core', 'cloud'].includes(scope))
    throw new Error(`Unknown Linux E2E scope: ${scope}`)
  const checkpoints = expandDesktopCheckpoints(segments)
  for (const checkpoint of checkpoints) {
    if (!DESKTOP_CHECKPOINTS.includes(checkpoint)) {
      throw new Error(`Unknown desktop E2E checkpoint: ${checkpoint}`)
    }
    const duration = seconds[checkpoint]
    if (
      duration !== undefined &&
      (!Number.isFinite(duration) || duration <= 0)
    ) {
      throw new Error(
        `Invalid Linux E2E duration for ${checkpoint}: ${duration}`,
      )
    }
  }
  // Start unmeasured additions first so a new long checkpoint cannot become a tail.
  // Stable sorting retains selection order for equal or unknown durations.
  return checkpoints.sort(
    (a, b) => (seconds[b] ?? Infinity) - (seconds[a] ?? Infinity),
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv[2] === '--balance-core') {
    if (!process.env.CORE_MATRIX) throw new Error('CORE_MATRIX is required')
    console.log(
      `matrix=${JSON.stringify(balanceLinuxCoreMatrix(
        JSON.parse(process.env.CORE_MATRIX),
        measurements.scopes.core,
        Number(process.env.CORE_RUNNER_SCALE ?? 1),
      ))}`,
    )
  } else {
    const segments = (process.env.WEWORK_E2E_SEGMENTS ?? '')
      .split(',')
      .filter(Boolean)
    if (!segments.length)
      throw new Error('WEWORK_E2E_SEGMENTS must select at least one checkpoint')
    console.log(
      orderLinuxCheckpoints(
        segments,
        process.env.WEWORK_E2E_PARALLEL_SCOPE,
      ).join(','),
    )
  }
}
