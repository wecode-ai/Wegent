import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RuntimeInteraction } from './runtimeInteractions'
import { createIssueHumanInteractionSource } from './issueHumanInteractionSource'

/** Account-owned shared inboxes retain only authority confirmed by their current API. */
export function createRuntimeInteractionInboxState(
  services: WorkbenchServices | undefined,
  cached: RuntimeInteraction[]
) {
  let cloud = createIssueHumanInteractionSource(services?.issueHumanRequestsApi, 'backend', cached)
  let local = createIssueHumanInteractionSource(
    services?.localIssueHumanRequestsApi,
    'local',
    cached
  )
  let cloudSnapshot = cloud.getSnapshot()
  let localSnapshot = local.getSnapshot()
  const combine = () => {
    const errors: Record<string, string> = {}
    if (cloudSnapshot.error !== undefined) errors['issue:backend'] = cloudSnapshot.error
    if (localSnapshot.error !== undefined) errors['issue:local'] = localSnapshot.error
    return {
      items: [...cloudSnapshot.items, ...localSnapshot.items],
      resolved: [...cloudSnapshot.resolved, ...localSnapshot.resolved],
      transferred: [...cloudSnapshot.transferred, ...localSnapshot.transferred],
      errors,
    }
  }
  let snapshot = combine()
  let stopCloud: (() => void) | undefined
  let stopLocal: (() => void) | undefined
  const listeners = new Set<() => void>()
  const getSnapshot = () => {
    if (cloudSnapshot !== cloud.getSnapshot() || localSnapshot !== local.getSnapshot()) {
      cloudSnapshot = cloud.getSnapshot()
      localSnapshot = local.getSnapshot()
      snapshot = combine()
    }
    return snapshot
  }
  const publish = () => {
    getSnapshot()
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot,
    configure(next: WorkbenchServices | undefined) {
      if (cloud.api !== next?.issueHumanRequestsApi) {
        stopCloud?.()
        cloud = createIssueHumanInteractionSource(next?.issueHumanRequestsApi, 'backend', [])
        stopCloud = listeners.size ? cloud.subscribe(publish) : undefined
      }
      if (local.api !== next?.localIssueHumanRequestsApi) {
        stopLocal?.()
        local = createIssueHumanInteractionSource(next?.localIssueHumanRequestsApi, 'local', [])
        stopLocal = listeners.size ? local.subscribe(publish) : undefined
      }
      publish()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        stopCloud = cloud.subscribe(publish)
        stopLocal = local.subscribe(publish)
      }
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          stopCloud?.()
          stopLocal?.()
          stopCloud = undefined
          stopLocal = undefined
        }
      }
    },
    async refresh(onlyStore?: 'local' | 'backend') {
      await Promise.all([
        ...(onlyStore !== 'local' ? [cloud.refresh()] : []),
        ...(onlyStore !== 'backend' ? [local.refresh()] : []),
      ])
    },
    async discover(localPending?: boolean) {
      await Promise.all([cloud.discover(), local.discover(localPending)])
    },
  }
}
