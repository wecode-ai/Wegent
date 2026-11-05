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
