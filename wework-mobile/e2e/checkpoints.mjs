export const MOBILE_CHECKPOINTS = [
  'authorization',
  'navigation',
  'projects',
  'conversation-setup',
  'models',
  'composer',
  'runtime',
  'history',
  'recovery',
  'settings',
  'appearance',
]

export const MOBILE_CHECKPOINT_SHARDS = [
  {
    id: 'device-and-projects',
    checkpoints: ['authorization', 'navigation', 'projects', 'conversation-setup'],
  },
  {
    id: 'composer-and-settings',
    checkpoints: ['models', 'composer', 'settings', 'appearance'],
  },
  {
    id: 'runtime-lifecycle',
    checkpoints: ['runtime', 'history', 'recovery'],
  },
]

const assignedCheckpoints = MOBILE_CHECKPOINT_SHARDS.flatMap(shard => shard.checkpoints)

if (
  assignedCheckpoints.length !== MOBILE_CHECKPOINTS.length ||
  new Set(assignedCheckpoints).size !== MOBILE_CHECKPOINTS.length ||
  MOBILE_CHECKPOINTS.some(checkpoint => !assignedCheckpoints.includes(checkpoint))
) {
  throw new Error('Every Mobile checkpoint must belong to exactly one CI shard')
}
