import { deliveryMessages } from './deliveryMessages'
import { useEffect, useState } from 'react'
import { ChevronRight, Package } from 'lucide-react'
import type { CollaborationTranslate } from '../i18n'
import type {
  SharedIssueDetailDelivery,
  SharedIssueDetailDeliveryDetail,
} from './createSharedIssueDetailPort'
import { formatIssueTimestamp } from './issueTimestamp'

export function IssueDeliveryRow({
  delivery,
  getDelivery,
  memberName,
  onOpen,
  translate,
}: {
  delivery: SharedIssueDetailDelivery
  getDelivery(id: string): Promise<SharedIssueDetailDeliveryDetail>
  memberName(id: number): string | null
  onOpen(id: string): void
  translate: CollaborationTranslate
}) {
  const [detail, setDetail] = useState<SharedIssueDetailDelivery | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (delivery.markdown !== undefined) return
    let active = true
    getDelivery(delivery.id)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [delivery.id, delivery.version, delivery.markdown, getDelivery])

  const snapshot = delivery.markdown !== undefined ? delivery : detail
  const notePreview =
    delivery.title?.trim() ||
    snapshot?.markdown
      ?.trim()
      .split(/\r?\n/, 1)[0]
      .replace(/^#{1,6}\s+/, '')
  const messageCount = deliveryMessages(snapshot?.chat).length
  const contents: string[] = []
  if (snapshot?.markdown?.trim())
    contents.push(translate('todo.delivery_notes', '交付说明'))
  if (messageCount > 0) {
    contents.push(
      translate('todo.delivery_message_count', '{{count}} 条消息', {
        count: messageCount,
      }),
    )
  }
  if (delivery.assets.length)
    contents.push(
      translate('todo.attachment_count', '{{count}} 个附件', {
        count: delivery.assets.length,
      }),
    )
  if (!snapshot)
    contents.push(
      failed
        ? translate('todo.delivery_summary_failed', '内容加载失败，点击查看')
        : translate('todo.delivery_summary_loading', '正在加载内容…'),
    )
  if (snapshot && contents.length === 0)
    contents.push(translate('todo.delivery_empty', '无交付内容'))
  const creatorId = delivery.created_by_user_id ?? detail?.created_by_user_id
  const creator =
    creatorId == null
      ? translate('todo.delivery_unknown_author', '交付人未知')
      : memberName(creatorId) ||
        translate('todo.delivery_author_id', '用户 #{{id}}', { id: creatorId })
  const at = delivery.delivered_at ?? delivery.created_at

  return (
    <button
      type="button"
      data-testid={`todo-detail-open-delivery-${delivery.id}`}
      onClick={() => onOpen(delivery.id)}
      className="task-detail-workspace-sub-row w-full text-left"
    >
      <Package className="h-4 w-4 shrink-0 text-text-muted" />
      <span className="min-w-0 flex-1 py-1">
        {notePreview && (
          <span
            className="block truncate text-sm font-medium text-text-primary"
            title={notePreview}
          >
            {notePreview}
          </span>
        )}
        <span className="block text-sm text-text-primary">
          {contents.join(' · ')}
        </span>
        {delivery.assets.length > 0 && (
          <span
            className="mt-0.5 block truncate text-xs text-text-secondary"
            title={delivery.assets
              .map((asset) => asset.relative_path)
              .join('\n')}
          >
            {delivery.assets
              .map((asset) => asset.display_name || asset.relative_path)
              .join('、')}
          </span>
        )}
        <span className="mt-0.5 block text-xs text-text-muted">
          {translate('todo.delivery_by', '{{name}} 交付', { name: creator })} ·{' '}
          <time dateTime={at}>{formatIssueTimestamp(at)}</time>
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-text-muted" />
    </button>
  )
}
