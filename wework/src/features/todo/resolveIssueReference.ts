import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { CloudLoopItem } from '@/api/deliveries'
import { ApiError } from '@/api/http'
import { DshExecutorTransportError } from '@/api/dsh/executorTransport'
import type { LocatedProjectSpace } from './projectSpaceSelection'

export interface IssueReferenceResult {
  project: LocatedProjectSpace
  item: CloudLoopItem
}

export interface IssueReferenceLookup {
  matches: IssueReferenceResult[]
  failures: Array<{ location: 'local' | 'cloud'; message: string }>
}

function isMissingIssue(error: unknown): boolean {
  return (
    (error instanceof ApiError && error.status === 404) ||
    (error instanceof DshExecutorTransportError &&
      (error.code === 'not_found' || error.code === 'http_404')) ||
    (error instanceof Error && error.message === 'Local task not found')
  )
}

export async function resolveIssueReference(
  reference: string,
  sources: Array<{ location: 'local' | 'cloud'; api: SharedWorkspaceApi }>
): Promise<IssueReferenceLookup> {
  const results = await Promise.allSettled(
    sources.map(async ({ location, api }) => {
      let item: Awaited<ReturnType<SharedWorkspaceApi['issues']['get']>>
      try {
        item = await api.issues.get(reference)
      } catch (error) {
        if (isMissingIssue(error)) return null
        throw error
      }
      const project = await api.projects.get(item.cloud_project_id)
      return {
        item: item as CloudLoopItem,
        project: {
          ...project,
          location,
          project_store: location === 'local' ? 'local' : 'backend',
        } as LocatedProjectSpace,
      }
    })
  )
  return {
    matches: results.flatMap(result =>
      result.status === 'fulfilled' && result.value ? [result.value] : []
    ),
    failures: results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [
            {
              location: sources[index].location,
              message:
                result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
          ]
        : []
    ),
  }
}
