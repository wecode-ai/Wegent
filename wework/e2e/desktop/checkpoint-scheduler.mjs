// These checkpoints materialize packaged runtimes or repeatedly reload the full
// renderer. Run them alone so Chromium's network service stays stable on the
// four-vCPU desktop E2E runners. CI shard estimates must account for this prefix.
export const RESOURCE_EXCLUSIVE_CHECKPOINTS = new Set([
  'background-terminals',
  'release-package-startup',
  'collaboration-issue-task-discovery',
  // Its partial-inventory guard must run through the real system-idle scheduler.
  // Parallel Electron workloads keep CPU pressure above the production limit.
  'plugin-uninstall-lost-response',
])

export const LINUX_CORE_HISTORY_CHECKPOINT = 'running-conversation-history'

export function isResourceExclusiveCheckpoint(checkpoint, linuxCore = false) {
  return (
    RESOURCE_EXCLUSIVE_CHECKPOINTS.has(checkpoint) ||
    (linuxCore && checkpoint === LINUX_CORE_HISTORY_CHECKPOINT)
  )
}

// Database and Backend startup in these fixtures can delay the 200ms Python
// descriptor request used by Python setup and plugin development. Keep these
// fixtures separate from both checkpoints on Linux Core.
const PYTHON_RUNTIME_STARTUP_PEERS = [
  'collaboration-shared-core',
  'collaboration-templates',
  'collaboration-template-lifecycle',
]

export function linuxCoreCheckpointResources(checkpoint) {
  if (checkpoint === 'python-runtime' || checkpoint === 'plugin-development') {
    return PYTHON_RUNTIME_STARTUP_PEERS
  }
  return PYTHON_RUNTIME_STARTUP_PEERS.includes(checkpoint) ? [checkpoint] : []
}

export async function runWithCheckpointResources({
  checkpoints,
  workerCount,
  resourceFor,
  exclusiveFor = () => false,
  run,
}) {
  const exclusiveCheckpoints = checkpoints.filter(checkpoint => exclusiveFor(checkpoint))
  for (const checkpoint of exclusiveCheckpoints) {
    await run(checkpoint)
  }
  const parallelCheckpoints = checkpoints.filter(checkpoint => !exclusiveFor(checkpoint))
  const resourcesByCheckpoint = new Map(
    parallelCheckpoints.map(checkpoint => {
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
  for (const checkpoint of parallelCheckpoints) {
    for (const resource of resourcesByCheckpoint.get(checkpoint)) {
      const count = (resourceCounts.get(resource) ?? 0) + 1
      resourceCounts.set(resource, count)
      if (count > 1) constrainedResources.add(resource)
    }
  }
  const pending = [
    ...parallelCheckpoints.filter(checkpoint =>
      resourcesByCheckpoint.get(checkpoint).some(resource => constrainedResources.has(resource))
    ),
    ...parallelCheckpoints.filter(
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
