import { useState, useSyncExternalStore } from 'react'
import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationIssue } from '../types'
import { MilestonePicker } from './MilestonePicker'
import { milestoneMessages } from './messages'
import { useMilestones } from './useMilestones'
import { createMilestoneBulkActionStore } from './milestoneBulkActionStore'

export function MilestoneBulkAction({
  api,
  projectId,
  issues,
  locale,
  onUpdated,
}: {
  api: SharedWorkspaceApi
  projectId: string
  issues: CollaborationIssue[]
  locale: 'en' | 'zh-CN'
  onUpdated(issue: CollaborationIssue): void
}) {
  const m = milestoneMessages[locale]
  const query = useMilestones(api.milestones, projectId)
  const authScope = api.milestones?.getCacheScope?.()
  const [owner, setOwner] = useState(() => ({
    api,
    projectId,
    authScope,
    store: createMilestoneBulkActionStore(api),
  }))
  const [value, setValue] = useState<string | null>()
  if (owner.api !== api || owner.projectId !== projectId || owner.authScope !== authScope) {
    setOwner({
      api,
      projectId,
      authScope,
      store: createMilestoneBulkActionStore(api),
    })
    setValue(undefined)
  }
  const snapshot = useSyncExternalStore(
    owner.store.subscribe,
    owner.store.getSnapshot,
    owner.store.getSnapshot
  )
  const { busy, freshIssues } = snapshot
  const [failureState, setFailureState] = useState(() => ({
    source: snapshot.failures,
    retained: snapshot.failures,
  }))
  if (failureState.source !== snapshot.failures) {
    setFailureState({ source: snapshot.failures, retained: snapshot.failures })
  }
  const failures =
    failureState.source === snapshot.failures ? failureState.retained : snapshot.failures
  if (!busy && failures.length) {
    const selected = new Set(issues.map(issue => issue.id))
    const remaining = failures.filter(id => selected.has(id))
    if (remaining.length !== failures.length)
      setFailureState({ source: snapshot.failures, retained: remaining })
  }
  async function apply() {
    if (value === undefined || query.loading || query.error || busy) return
    await owner.store.apply(issues, value, failures, m.bulkFailed, onUpdated)
  }

  return (
    <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
      <MilestonePicker
        api={api.milestones}
        query={query}
        projectId={projectId}
        value={value}
        onChange={next => {
          setValue(next)
          setFailureState({ source: snapshot.failures, retained: [] })
        }}
        label={m.bulk}
        searchLabel={m.search}
        emptyLabel={m.noMatches}
        placeholder={m.choose}
        noneLabel={m.unlink}
        errorLabel={m.error}
        retryLabel={m.retry}
        disabled={busy}
        testId="milestone-bulk-select"
      />
      <button
        type="button"
        data-testid="milestone-bulk-apply"
        disabled={busy || value === undefined || query.loading || query.error}
        className="min-h-11 shrink-0 whitespace-nowrap rounded-md border border-border px-3 text-sm md:min-h-8"
        onClick={() => void apply()}
      >
        {failures.length ? m.retryFailed : m.apply}
      </button>
      {failures.length ? (
        <span role="alert">
          {m.bulkFailed}{' '}
          {failures
            .map(id => freshIssues[id]?.title || issues.find(issue => issue.id === id)?.title || id)
            .join(', ')}
        </span>
      ) : null}
    </div>
  )
}
