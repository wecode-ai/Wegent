import { useEffect, useRef, useState } from 'react'
import {
  createCollaborationTranslator,
  IssueArchiveDialog,
  prepareIssueArchiveSubtree,
  type CollaborationIssue,
  type SharedWorkspaceApi,
} from '@wegent/collaboration'

export function ThreadArchiveDialog({
  item,
  items,
  api,
  locale,
  onPrepare,
  onClose,
  onArchived,
}: {
  item: CollaborationIssue
  items: CollaborationIssue[]
  api: SharedWorkspaceApi
  locale: 'zh-CN' | 'en'
  onPrepare?(item: CollaborationIssue): Promise<void>
  onClose(): void
  onArchived(): void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const confirm = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await prepareIssueArchiveSubtree(items, item, onPrepare)
      await api.issues.archive(item.id)
      if (mounted.current) onArchived()
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  return (
    <IssueArchiveDialog
      busy={busy}
      error={error}
      title={item.title}
      hasChildren={items.some(candidate => candidate.parent_id === item.id)}
      translate={createCollaborationTranslator(locale)}
      onCancel={onClose}
      onConfirm={() => void confirm()}
    />
  )
}
