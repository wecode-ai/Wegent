import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { expandDesktopCheckpoints } from '../../wework/e2e/desktop/checkpoints.mjs'

const measurements = JSON.parse(
  readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
)

const preparationGroups = {
  'local-harness': ['claude-runtime', 'local-harness', 'workbench-mode', 'native-window-startup'],
  'object-storage': ['collaboration-issue-mcp-comments', 'collaboration-delivery-editing'],
  'dingtalk-protocol-fixture': ['stand-in-identities', 'stand-in-connections', 'stand-in-cli'],
}

function preparationTasks(checkpoints) {
  const pending = new Map(checkpoints.map(checkpoint => [checkpoint.segment, checkpoint]))
  const tasks = []
  // These checkpoints shared expensive preparation in the original Core matrix.
  for (const [preparation, group] of Object.entries(preparationGroups)) {
    const members = group.map(segment => pending.get(segment)).filter(Boolean)
    if (!members.length) continue
    tasks.push({
      segments: members.map(checkpoint => checkpoint.segment),
      seconds: members.reduce(
        (total, checkpoint) => total + checkpoint.seconds,
        measurements.preparationSeconds[preparation]
      ),
    })
    for (const checkpoint of members) pending.delete(checkpoint.segment)
  }
  for (const checkpoint of pending.values()) {
    tasks.push({ segments: [checkpoint.segment], seconds: checkpoint.seconds })
  }
  return tasks.sort((a, b) => b.seconds - a.seconds || a.segments[0].localeCompare(b.segments[0]))
}

export function checkpointSeconds(segment, seconds = measurements.seconds) {
  const checkpoints = expandDesktopCheckpoints([segment])
  if (checkpoints.some(checkpoint => seconds[checkpoint] === undefined)) return null
  return checkpoints.reduce((total, checkpoint) => total + seconds[checkpoint], 0)
}

export function balanceWindowsMatrix(matrix, seconds = measurements.seconds) {
  // Preserve the two exclusive benchmark shards and the existing runner budget.
  const fixed = new Set(['core-9', 'core-10'])
  const unmeasured = new Set()
  const preparationSegments = new Set(Object.values(preparationGroups).flat())
  for (const entry of matrix.include) {
    const unknown = entry.segments
      .split(',')
      .filter(segment => checkpointSeconds(segment, seconds) === null)
    if (!unknown.length) continue
    // Do not split a preparation group when one member's cost is unknown.
    if (unknown.some(segment => preparationSegments.has(segment))) fixed.add(entry.id)
    else unmeasured.add(entry.id)
  }
  const shards = matrix.include.map(entry => ({
    ...entry,
    segments: [],
    seconds: 0,
  }))
  // Never add measured work to a shard whose remaining cost is unknown.
  const ordinary = shards.filter(entry => !fixed.has(entry.id) && !unmeasured.has(entry.id))
  if (!ordinary.length) {
    // A partial selection with no measured destination retains its original work.
    for (const id of unmeasured) fixed.add(id)
  }
  const pending = []
  const seen = new Set()
  for (const [index, entry] of matrix.include.entries()) {
    for (const segment of entry.segments.split(',')) {
      if (seen.has(segment)) throw new Error(`Duplicate Windows Core segment: ${segment}`)
      seen.add(segment)
      const duration = checkpointSeconds(segment, seconds)
      if (fixed.has(entry.id) || duration === null) {
        shards[index].segments.push(segment)
        shards[index].seconds += duration ?? 0
      } else {
        pending.push({ segment, seconds: duration })
      }
    }
  }
  for (const task of preparationTasks(pending)) {
    const target = ordinary.reduce((best, shard) => (shard.seconds < best.seconds ? shard : best))
    target.segments.push(...task.segments)
    target.seconds += task.seconds
  }
  return {
    include: shards
      .filter(shard => shard.segments.length)
      .map(({ seconds: _, ...entry }) => ({
        ...entry,
        segments: entry.segments.join(','),
      })),
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matrix = balanceWindowsMatrix(JSON.parse(process.env.CORE_MATRIX))
  console.log(`matrix=${JSON.stringify(matrix)}`)
}
