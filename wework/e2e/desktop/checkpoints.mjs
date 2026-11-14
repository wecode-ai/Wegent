import { loadDesktopCheckpointCatalog } from './checkpoint-catalog.mjs'

const catalog = loadDesktopCheckpointCatalog()

export const {
  DESKTOP_CHECKPOINTS,
  PLUGIN_SEGMENTS,
  DESKTOP_CHECKPOINT_GROUPS,
  DESKTOP_CHECKPOINT_CI_HOSTS,
  CHECKPOINT_RESOURCES,
  CHECKPOINT_SCENARIO_MODULES,
  SCENARIO_ONLY_CHECKPOINTS,
  CLOUD_ONLY_CHECKPOINTS,
} = catalog

export function desktopCheckpointArgs(
  checkpoint,
  scope = CLOUD_ONLY_CHECKPOINTS.has(checkpoint) ? 'cloud' : 'core'
) {
  if (!['cloud', 'core'].includes(scope)) {
    throw new Error('Desktop checkpoint scope must be "cloud" or "core"')
  }
  const args = ['--segment', checkpoint]
  // A scenario owns its prerequisites; cloud placement is not an execution mode.
  return scope === 'cloud' && !SCENARIO_ONLY_CHECKPOINTS.has(checkpoint)
    ? ['--cloud-only', ...args]
    : args
}

export function expandDesktopCheckpoints(checkpoints) {
  const expanded = []
  const seen = new Set()
  for (const checkpoint of checkpoints) {
    const members = DESKTOP_CHECKPOINT_GROUPS.get(checkpoint) ?? [checkpoint]
    for (const member of members) {
      if (seen.has(member)) continue
      seen.add(member)
      expanded.push(member)
    }
  }
  return expanded
}
