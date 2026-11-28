import type { Profiler } from 'node:inspector'
import { redactLog } from '../runtime/rotating-log.js'

export function profileHotFrames(profile: Profiler.Profile) {
  const samples = profile.samples ?? []
  const durations = profile.timeDeltas ?? []
  const costs = new Map<number, number>()
  for (const [index, id] of samples.entries()) {
    costs.set(id, (costs.get(id) ?? 0) + (durations[index] ?? 0))
  }
  return profile.nodes
    .filter(node => costs.has(node.id))
    .map(({ id, callFrame }) => ({
      functionName: redactLog(callFrame.functionName).slice(0, 160),
      source: URL.canParse(callFrame.url)
        ? redactLog(new URL(callFrame.url).pathname).slice(0, 300)
        : '',
      line: callFrame.lineNumber + 1,
      selfMs: (costs.get(id) ?? 0) / 1_000,
    }))
    .sort((left, right) => right.selfMs - left.selfMs)
    .slice(0, 12)
}
