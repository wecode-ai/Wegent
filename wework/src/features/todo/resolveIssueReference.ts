import type { SharedWorkspaceApi } from '@wegent/collaboration'
import type { CloudLoopItem } from '@/api/deliveries'
import type { LocatedProjectSpace } from './projectSpaceSelection'

export interface IssueReferenceResult {
  project: LocatedProjectSpace
  item: CloudLoopItem
}

export async function resolveIssueReference(
  reference: string,
  sources: Array<{ location: 'local' | 'cloud'; api: SharedWorkspaceApi }>
): Promise<IssueReferenceResult[]> {
  const results = await Promise.allSettled(
    sources.map(async ({ location, api }) => {
      const item = await api.issues.get(reference)
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
  const matches = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))
  if (matches.length === 0) {
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    throw new AggregateError(
      errors,
      errors.map(error => (error instanceof Error ? error.message : String(error))).join('; ')
    )
  }
  return matches
}
