export async function runWithCheckpointResources({ checkpoints, workerCount, resourceFor, run }) {
  const constrainedResources = new Set()
  const resourceCounts = new Map()
  for (const checkpoint of checkpoints) {
    const resource = resourceFor(checkpoint)
    if (!resource) continue
    const count = (resourceCounts.get(resource) ?? 0) + 1
    resourceCounts.set(resource, count)
    if (count > 1) constrainedResources.add(resource)
  }
  const pending = [
    ...checkpoints.filter(checkpoint => constrainedResources.has(resourceFor(checkpoint))),
    ...checkpoints.filter(checkpoint => !constrainedResources.has(resourceFor(checkpoint))),
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
        const resource = resourceFor(checkpoint)
        return !resource || !activeResources.has(resource)
      })
      if (index >= 0) {
        const [checkpoint] = pending.splice(index, 1)
        const resource = resourceFor(checkpoint)
        if (resource) activeResources.add(resource)
        return { checkpoint, resource }
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
        if (item.resource) activeResources.delete(item.resource)
        wakeWorkers()
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
