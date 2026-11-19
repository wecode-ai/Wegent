import { useCallback, useState, useSyncExternalStore } from 'react'
import { createTaskActivityState, type TaskActivityInput } from './taskActivityState'

type ActivityOwner = Parameters<typeof createTaskActivityState>
export function useTaskActivityState(
  scope: string,
  client: ActivityOwner[0],
  api: ActivityOwner[1],
  agentApi: ActivityOwner[2],
  projectId: string,
  issueId: string,
  input: TaskActivityInput
) {
  const [selection, setSelection] = useState(() => ({
    scope,
    client,
    api,
    agentApi,
    projectId,
    issueId,
    source: createTaskActivityState(client, api, agentApi, projectId, issueId),
  }))
  let current = selection
  if (
    selection.scope !== scope ||
    selection.client !== client ||
    selection.api !== api ||
    selection.agentApi !== agentApi ||
    selection.projectId !== projectId ||
    selection.issueId !== issueId
  ) {
    current = {
      scope,
      client,
      api,
      agentApi,
      projectId,
      issueId,
      source: createTaskActivityState(client, api, agentApi, projectId, issueId),
    }
    setSelection(current)
  }
  const source = current.source
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, input),
    [source, input]
  )
  const snapshot = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  return { source, snapshot }
}
