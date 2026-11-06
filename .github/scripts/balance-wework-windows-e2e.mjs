import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { expandDesktopCheckpoints } from '../../wework/e2e/desktop/checkpoints.mjs'

const measurements = JSON.parse(
  readFileSync(new URL('../ci/wework-windows-checkpoint-durations.json', import.meta.url))
)

// Keep shared setup in one runner, including when a member has no timing yet.
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

function selectedCheckpointEntries(matrix, seconds) {
  const seen = new Set()
  return matrix.include.map(entry => {
    const checkpoints = entry.segments.split(',').map(segment => {
      if (seen.has(segment)) throw new Error(`Duplicate Windows Core segment: ${segment}`)
      seen.add(segment)
      return { segment, seconds: checkpointSeconds(segment, seconds) }
    })
    const unknown = checkpoints.filter(checkpoint => checkpoint.seconds === null)
    const pinned = new Set(unknown.map(checkpoint => checkpoint.segment))
    for (const group of Object.values(preparationGroups)) {
      if (group.some(segment => pinned.has(segment))) {
        for (const segment of group) pinned.add(segment)
      }
    }
    return { checkpoints, pinned }
  })
}

export function balanceWindowsMatrix(matrix, seconds = measurements.seconds) {
  // Preserve the two exclusive benchmark shards and the existing runner budget.
  const fixed = new Set(['core-9', 'core-10'])
  const entries = selectedCheckpointEntries(matrix, seconds)
  const shards = matrix.include.map(entry => ({
    ...entry,
    segments: [],
    seconds: 0,
  }))
  // Unknown costs stay opaque: reserve their original runner and move only
  // measured work away, so a long known prefix cannot starve new coverage.
  const ordinary = shards.filter(
    (entry, index) => !fixed.has(entry.id) && !entries[index].pinned.size
  )
  if (!ordinary.length) return matrix
  const pending = []
  for (const [index, entry] of matrix.include.entries()) {
    for (const checkpoint of entries[index].checkpoints) {
      if (fixed.has(entry.id) || entries[index].pinned.has(checkpoint.segment)) {
        shards[index].segments.push(checkpoint.segment)
      } else {
        pending.push(checkpoint)
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
