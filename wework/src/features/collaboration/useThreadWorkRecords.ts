import { useCallback, useEffect, useMemo, useState } from 'react'
import { createSharedIssueDetailPort } from '@wegent/collaboration'
import { saveBlobToDownloads } from '@/lib/blobDownload'
import { ApiError } from '@/api/http'
import type { ThreadActionContext } from './threadActions'

interface RecordResult<T> {
  scope: object
  request: string
  items: T[]
  error: boolean
}

function useThreadRecord<T>(
  scope: object,
  request: string,
  load: () => Promise<T[]>,
  enabled: boolean
) {
  const [result, setResult] = useState<RecordResult<T> | null>(null)
  useEffect(() => {
    if (!enabled) return
    let active = true
    void Promise.resolve()
      .then(load)
      .then(items => {
        if (active) setResult({ scope, request, items, error: false })
      })
      .catch(error => {
        const denied = error instanceof ApiError && [401, 403, 404].includes(error.status)
        if (active)
          setResult(previous => ({
            scope,
            request,
            items: !denied && previous?.scope === scope ? previous.items : [],
            error: true,
          }))
      })
    return () => {
      active = false
    }
  }, [scope, request, load, enabled])
  const current = result?.scope === scope ? result : null
  return {
    items: enabled ? (current?.items ?? []) : [],
    loading: !enabled || !current || current.request !== request,
    error: current?.request === request && current.error,
  }
}

export function useThreadWorkRecords(context: ThreadActionContext) {
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(value => value + 1), [])
  const actor = context.participation?.current_user_id
  const scope = useMemo(
    () => ({
      api: context.api,
      owner: `${context.accountScope}:${context.sourceStore}:${context.group.id}:${context.item.id}:${actor}`,
    }),
    [
      context.api,
      context.accountScope,
      context.sourceStore,
      context.group.id,
      context.item.id,
      actor,
    ]
  )
  const request = `${context.item.version}:${revision}`
  const port = useMemo(
    () =>
      createSharedIssueDetailPort(
        context.api,
        async (blob, filename) => {
          await saveBlobToDownloads(blob, filename)
        },
        context.api.runtime?.getTranscript,
        { projectId: context.group.id, issueId: context.item.id }
      ),
    [context.api, context.group.id, context.item.id]
  )
  const loadBindings = useCallback(
    async () =>
      (await port.taskBindings.list(context.item.id, context.group.id)).filter(
        binding =>
          actor !== undefined &&
          String(binding.task_user_id) === String(actor) &&
          String(binding.cloud_project_id) === context.group.id &&
          String(binding.loop_item_id) === context.item.id
      ),
    [port, context.item.id, context.group.id, actor]
  )
  const loadDeliveries = useCallback(
    () => port.deliveries.list(context.item.id),
    [port, context.item.id]
  )
  const enabled = actor !== undefined
  const bindings = useThreadRecord(scope, request, loadBindings, enabled)
  const deliveries = useThreadRecord(scope, request, loadDeliveries, enabled)
  return { actor, scope, port, bindings, deliveries, refresh }
}
