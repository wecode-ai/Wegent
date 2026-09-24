export async function runWithCheckpointResources({ checkpoints, workerCount, resourceFor, run }) {
  const pending = [...checkpoints]
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
