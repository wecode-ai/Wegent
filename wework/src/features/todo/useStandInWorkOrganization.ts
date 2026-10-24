import { useState } from 'react'
import type { StandInExecutorApi, StandInInboxWork } from '@/api/standIn'

export interface StandInWorkDrag {
  workId: string
  roleId: string
  title: string
  messageIds?: string[]
  canSplit?: boolean
}

export function useStandInWorkOrganization({
  api,
  userId,
  deviceId,
  onRefresh,
  onSelect,
}: {
  api?: StandInExecutorApi
  userId?: number
  deviceId?: string
  onRefresh?(): void
  onSelect(work: StandInInboxWork): void
}) {
  const [drag, setDrag] = useState<StandInWorkDrag | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [hover, setHover] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<{
    sourceId: string
    destinationId: string
    ids: string[]
    kind: 'merged' | 'split' | 'moved'
  } | null>(null)
  const cancel = () => {
    setDrag(null)
    setChoosing(false)
    setHover(null)
  }
  const organize = async (source: StandInWorkDrag, target?: StandInInboxWork) => {
    if (
      !api ||
      userId === undefined ||
      !deviceId ||
      busy ||
      target?.id === source.workId ||
      (target && target.roleId !== source.roleId)
    )
      return
    setBusy(true)
    setError(null)
    cancel()
    try {
      const ids =
        source.messageIds ??
        (await api.workMessages(userId, deviceId, source.workId)).messages.map(
          message => message.recordId
        )
      const result = await api.organizeWork(userId, deviceId, source.workId, ids, target?.id)
      setUndo({
        sourceId: source.workId,
        destinationId: result.id,
        ids,
        kind: !target ? 'split' : source.messageIds ? 'moved' : 'merged',
      })
      onSelect(result)
      onRefresh?.()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const undoOrganization = async () => {
    if (!undo || !api || userId === undefined || !deviceId || busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.organizeWork(
        userId,
        deviceId,
        undo.destinationId,
        undo.ids,
        undo.sourceId
      )
      setUndo(null)
      onSelect(result)
      onRefresh?.()
    } catch (cause) {
      setError(String(cause))
    } finally {
      setBusy(false)
    }
  }
  return {
    drag,
    setDrag,
    choosing,
    setChoosing,
    hover,
    setHover,
    busy,
    error,
    undo,
    organize,
    undoOrganization,
    cancel,
  }
}
