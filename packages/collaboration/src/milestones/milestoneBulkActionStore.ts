import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue } from '../types'
import { bulkIssueStatus } from '../platform/bulkIssueStatus'

interface BulkSnapshot {
  busy: boolean
  failures: string[]
  freshIssues: Record<string, CollaborationIssue>
}

/** One mounted project/account owns its batch and may publish its results. */
export function createMilestoneBulkActionStore(api: SharedWorkspaceApi) {
  let snapshot: BulkSnapshot = { busy: false, failures: [], freshIssues: {} }
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (patch: Partial<BulkSnapshot>) => {
    snapshot = { ...snapshot, ...patch }
    listeners.forEach(listener => listener())
  }

  async function apply(
    issues: CollaborationIssue[],
    value: string | null,
    retryIds: string[],
    errorLabel: string,
    onUpdated: (issue: CollaborationIssue) => void
  ) {
    if (snapshot.busy || !listeners.size) return
    const current = ++generation
    const isCurrent = () => current === generation && listeners.size > 0
    publish({ busy: true })
    const targets = retryIds.length ? issues.filter(issue => retryIds.includes(issue.id)) : issues
    const completed: CollaborationIssue[] = []
    const failed = await bulkIssueStatus(
      targets,
      async selected => {
        // Retries read current authority and version instead of replaying an old patch.
        const issue = retryIds.includes(selected.id) ? await api.issues.get(selected.id) : selected
        if (!isCurrent()) return null
        if ((issue.milestone_id ?? null) === value) {
          completed.push(issue)
          return issue
        }
        const updated = await api.issues.update(issue.id, {
          version: issue.version,
          milestoneId: value,
        })
        completed.push(updated)
        return updated
      },
      () => errorLabel
    )
    if (!isCurrent()) return
    const failedIds = failed.map(failure => failure.issueId)
    const refreshed = await Promise.allSettled(failedIds.map(id => api.issues.get(id)))
    if (!isCurrent()) return
    // Reconcile the entire batch before moved Issues leave the current filtered view.
    completed.forEach(issue => onUpdated(issue))
    refreshed.forEach(result => {
      if (result.status === 'fulfilled') onUpdated(result.value)
    })
    publish({
      busy: false,
      failures: failedIds,
      freshIssues: Object.fromEntries(
        refreshed.flatMap(result =>
          result.status === 'fulfilled' ? [[result.value.id, result.value]] : []
        )
      ),
    })
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          snapshot = { ...snapshot, busy: false }
        }
      }
    },
    apply,
  }
}
