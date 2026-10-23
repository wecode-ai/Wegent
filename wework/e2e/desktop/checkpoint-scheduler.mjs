const RUNNER_EXCLUSIVE_CHECKPOINTS = new Set(['background-terminals'])

export async function runWithCheckpointResources({
  checkpoints,
  workerCount,
  resourceFor,
  run,
  exclusiveFor = checkpoint => RUNNER_EXCLUSIVE_CHECKPOINTS.has(checkpoint),
}) {
  const resourcesByCheckpoint = new Map(
    checkpoints.map(checkpoint => {
      const configuredResources = resourceFor(checkpoint)
      const resources = Array.isArray(configuredResources)
        ? configuredResources
        : configuredResources
          ? [configuredResources]
          : []
      return [checkpoint, [...new Set(resources)]]
    })
  )
  const constrainedResources = new Set()
  const resourceCounts = new Map()
  for (const checkpoint of checkpoints) {
    for (const resource of resourcesByCheckpoint.get(checkpoint)) {
      const count = (resourceCounts.get(resource) ?? 0) + 1
      resourceCounts.set(resource, count)
      if (count > 1) constrainedResources.add(resource)
    }
  }
  const ordered = [
    ...checkpoints.filter(checkpoint =>
      resourcesByCheckpoint.get(checkpoint).some(resource => constrainedResources.has(resource))
    ),
    ...checkpoints.filter(
      checkpoint =>
        !resourcesByCheckpoint.get(checkpoint).some(resource => constrainedResources.has(resource))
    ),
  ]
  // Keep native-input latency checks alone without adding another CI shard.
  const exclusive = new Set(checkpoints.filter(exclusiveFor))
  const pending = [
    ...ordered.filter(checkpoint => exclusive.has(checkpoint)),
    ...ordered.filter(checkpoint => !exclusive.has(checkpoint)),
  ]
  const activeResources = new Set()
  const waiters = new Set()
  let activeCount = 0
  let exclusiveActive = false

  const wakeWorkers = () => {
    for (const wake of waiters) wake()
    waiters.clear()
  }

  const nextCheckpoint = async () => {
    while (pending.length > 0) {
      const index = pending.findIndex(checkpoint => {
        if (exclusiveActive || (exclusive.has(checkpoint) && activeCount > 0)) return false
        const resources = resourcesByCheckpoint.get(checkpoint)
        return resources.every(resource => !activeResources.has(resource))
      })
      if (index >= 0) {
        const [checkpoint] = pending.splice(index, 1)
        const resources = resourcesByCheckpoint.get(checkpoint)
        for (const resource of resources) activeResources.add(resource)
        activeCount += 1
        exclusiveActive = exclusive.has(checkpoint)
        return { checkpoint, resources }
      }
      await new Promise(resolve => waiters.add(resolve))
    }
    return null
  }

  const worker = async () => {
    while (true) {
      const item = await nextCheckpoint()
      if (!item) return
      try {
        await run(item.checkpoint)
      } finally {
        for (const resource of item.resources) activeResources.delete(resource)
        activeCount -= 1
        if (exclusive.has(item.checkpoint)) exclusiveActive = false
        wakeWorkers()
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
