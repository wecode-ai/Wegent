import {
  independentIssueInput,
  type IndependentIssue,
  type IndependentIssueInput,
} from '@/api/personalIssues'
import { participantKey, type IssueParticipant } from './issueParticipants'

interface IssueDraftState {
  draft: IndependentIssueInput
  people: IssueParticipant[]
  projectId: string
  projectStatus: string
}

/** The editor and its leave guard observe the same Issue draft and project selection. */
export function createIndependentIssueDraft(issue: IndependentIssue | null, userId: number) {
  const owner = issue?.creator_id ?? userId
  const draft: IndependentIssueInput = issue
    ? independentIssueInput(issue)
    : {
        title: '',
        description: '',
        status: 'pending',
        priority: 'medium',
        assignee_id: userId,
        participants: [],
        resource_participants: [],
        archived: false,
        due_at: null,
      }
  const baseline = JSON.stringify(draft)
  let state: IssueDraftState = {
    draft,
    projectId: '',
    projectStatus: '',
    people: [
      {
        key: `human:${owner}`,
        kind: 'human',
        id: owner,
        name: issue?.people[owner] ?? `#${owner}`,
      },
      ...(issue?.metadata.direct_participants ?? issue?.metadata.participants ?? [])
        .filter(id => id !== owner)
        .map(id => ({
          key: `human:${id}`,
          kind: 'human' as const,
          id,
          name: issue?.people[id] ?? `#${id}`,
        })),
      ...(issue?.metadata.resource_participants ?? []).map(resource => ({
        key: participantKey(resource),
        kind: resource.kind,
        id: resource.id,
        name: resource.name,
      })),
    ],
  }
  const observers = new Map<
    () => void,
    { onDirtyChange?: (dirty: boolean) => void; last: boolean }
  >()
  const dirty = () => JSON.stringify(state.draft) !== baseline || Boolean(state.projectId)
  const set = <K extends keyof IssueDraftState>(
    key: K,
    value: IssueDraftState[K] | ((current: IssueDraftState[K]) => IssueDraftState[K])
  ) => {
    const next =
      typeof value === 'function'
        ? (value as (current: IssueDraftState[K]) => IssueDraftState[K])(state[key])
        : value
    if (next === state[key]) return
    state = { ...state, [key]: next }
    const changed = dirty()
    for (const [listener, observation] of observers) {
      listener()
      if (observation.last === changed) continue
      observation.last = changed
      observation.onDirtyChange?.(changed)
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void, onDirtyChange?: (dirty: boolean) => void) {
      const current = dirty()
      observers.set(listener, { onDirtyChange, last: current })
      onDirtyChange?.(current)
      return () => {
        observers.delete(listener)
      }
    },
    setDraft: (
      value:
        | IssueDraftState['draft']
        | ((current: IssueDraftState['draft']) => IssueDraftState['draft'])
    ) => set('draft', value),
    setPeople: (value: IssueParticipant[]) => set('people', value),
    setProjectId: (value: string) => set('projectId', value),
    setProjectStatus: (value: string) => set('projectStatus', value),
  }
}
