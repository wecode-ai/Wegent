import type { RuntimeWorkListResponse } from '@/types/api'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import {
  connectionEventSubscriptions,
  type ConnectionEventSubscription,
} from '@/lib/runtime-connection-events'

export interface ChangeRequestObservation {
  deviceId: string
  taskId: string
  url: string
  subscription: ConnectionEventSubscription
}

export function changeRequestResourceEventKeys(snapshot: TaskChangeRequestSnapshot): string[] {
  const request = snapshot.changeRequest
  if (!request?.headSha || request.checks !== 'failure') return []
  return [
    ...new Set(
      (snapshot.resourceEvents ?? [])
        .filter(
          event =>
            event.topicId === request.url &&
            event.external?.headSha === request.headSha &&
            ['change_request_state', 'checks', 'check_run', 'pipeline'].includes(
              event.external?.objectKind ?? ''
            ) &&
            ['failure', 'failed', 'cancelled', 'timed_out', 'action_required'].includes(
              event.external?.conclusion ?? event.external?.status ?? ''
            )
        )
        .map(event => event.key)
    ),
  ]
}

/** Git providers define canonical repository identities and structured selected objects. */
export function changeRequestObservations(
  work: RuntimeWorkListResponse | null | undefined
): ChangeRequestObservation[] {
  return [
    ...(work?.chats ?? []),
    ...(work?.projects ?? []).flatMap(project => project.deviceWorkspaces),
  ].flatMap(workspace =>
    workspace.tasks.flatMap(task =>
      connectionEventSubscriptions(task.runtimeHandle?.connectionEventSubscriptions, true).flatMap(
        subscription => {
          const source = subscription.source
          const platform = source.providerId?.startsWith('@wegent/dsh-connection-git/')
            ? source.providerId.slice('@wegent/dsh-connection-git/'.length)
            : undefined
          if (
            source.kind !== 'repository' ||
            !['github', 'gitlab'].includes(platform ?? '') ||
            !source.profile
          )
            return []
          let profile: unknown
          try {
            profile = JSON.parse(source.profile)
          } catch {
            return []
          }
          if (
            !Array.isArray(profile) ||
            typeof profile[0] !== 'string' ||
            !Array.isArray(source.monitoredObjects)
          )
            return []
          const instance = profile[0]
          return source.monitoredObjects
            .filter(
              object =>
                object.entityKind === 'change_request' &&
                Number.isSafeInteger(object.number) &&
                object.number > 0
            )
            .map(object => ({
              deviceId: workspace.deviceId,
              taskId: task.taskId,
              url: `${instance.replace(/\/$/, '')}/${source.name}/${platform === 'github' ? 'pull' : '-/merge_requests'}/${object.number}`,
              subscription,
            }))
        }
      )
    )
  )
}
