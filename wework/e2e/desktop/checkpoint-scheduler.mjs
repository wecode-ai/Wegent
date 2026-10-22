export async function runWithCheckpointResources({ checkpoints, workerCount, resourceFor, run }) {
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
  const pending = [
    ...checkpoints.filter(checkpoint =>
      resourcesByCheckpoint.get(checkpoint).some(resource => constrainedResources.has(resource))
    ),
    ...checkpoints.filter(
      checkpoint =>
        !resourcesByCheckpoint.get(checkpoint).some(resource => constrainedResources.has(resource))
    ),
  ]
  const activeResources = new Set()
  const waiters = new Set()

  const wakeWorkers = () => {
    for (const wake of waiters) wake()
    waiters.clear()
  }

  const nextCheckpoint = async () => {
    while (pending.length > 0) {
      const index = pending.findIndex(checkpoint => {
        const resources = resourcesByCheckpoint.get(checkpoint)
        return resources.every(resource => !activeResources.has(resource))
      })
      if (index >= 0) {
        const [checkpoint] = pending.splice(index, 1)
        const resources = resourcesByCheckpoint.get(checkpoint)
        for (const resource of resources) activeResources.add(resource)
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
        wakeWorkers()
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
