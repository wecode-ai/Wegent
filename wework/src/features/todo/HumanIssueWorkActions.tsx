import { useState } from 'react'
import { CircleCheck, Loader2, Play, RotateCcw, Send, Sparkles } from 'lucide-react'
import type { CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type WorkApi = Pick<
  DeliveryApi,
  'startHumanIssueWork' | 'submitHumanIssueWork' | 'reviewHumanIssueWork' | 'getLoopItem'
>

export interface HumanIssueWorkActionsProps {
  item: CloudLoopItem
  api: WorkApi
  onUpdated: (item: CloudLoopItem) => void
  onCreateTask?: () => void
}

const primaryActionClassName =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3 text-sm font-semibold text-primary-contrast transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50'
const secondaryActionClassName =
  'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-transparent bg-transparent px-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50'

export function HumanIssueWorkActions({
  item,
  api,
  onUpdated,
  onCreateTask,
}: HumanIssueWorkActionsProps) {
  const { t } = useTranslation('common')
  const [form, setForm] = useState<'submit' | 'request_changes' | null>(null)
  const [text, setText] = useState('')
  const [requestId, setRequestId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const work = item.human_work
  if (!work) return null

  const openForm = (next: 'submit' | 'request_changes') => {
    setForm(next)
    setText('')
    setRequestId(crypto.randomUUID())
    setError(null)
  }
  const run = async (action: 'start' | 'submit' | 'accept' | 'request_changes') => {
    setBusy(true)
    setError(null)
    try {
      const result =
        action === 'start'
          ? await api.startHumanIssueWork(item.id, item.version)
          : action === 'submit'
            ? await api.submitHumanIssueWork(item.id, item.version, text.trim(), requestId)
            : await api.reviewHumanIssueWork(
                item.id,
                item.version,
                action,
                action === 'request_changes' ? requestId : crypto.randomUUID(),
                action === 'request_changes' ? text.trim() : undefined
              )
      onUpdated(result.issue)
      setForm(null)
      setText('')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : t('todo.human_work_failed', '操作失败，请重试')
      )
      try {
        onUpdated(await api.getLoopItem(item.id))
      } catch {
        // Keep the current Issue visible so the user can retry after reconnecting.
      }
    } finally {
      setBusy(false)
    }
  }

  const canAssist = work.can_submit && Boolean(onCreateTask)
  const hasActions = work.can_start || work.can_submit || canAssist || work.can_review
  return (
    <>
      {hasActions ? (
        <div
          className="mr-2 flex shrink-0 items-center gap-1 rounded-lg bg-muted/60 p-0.5"
          data-testid="human-issue-actions"
        >
          {work.can_start ? (
            <button
              type="button"
              className={primaryActionClassName}
              data-testid="human-issue-start"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void run('start')}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              )}
              {t('todo.human_work_start', '接手处理')}
            </button>
          ) : null}
          {work.can_submit ? (
            <button
              type="button"
              className={primaryActionClassName}
              data-testid="human-issue-submit"
              disabled={busy}
              onClick={() => openForm('submit')}
            >
              <Send className="h-3.5 w-3.5" aria-hidden="true" />
              {t('todo.human_work_submit', '提交待确认')}
            </button>
          ) : null}
          {canAssist ? (
            <button
              type="button"
              className={secondaryActionClassName}
              data-testid="human-issue-ai-assist"
              disabled={busy}
              onClick={() => onCreateTask?.()}
            >
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {t('todo.human_work_ai_assist', 'AI 辅助')}
            </button>
          ) : null}
          {work.can_review ? (
            <>
              <button
                type="button"
                className={primaryActionClassName}
                data-testid="human-issue-accept"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void run('accept')}
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <CircleCheck className="h-3.5 w-3.5" aria-hidden="true" />
                )}
                {t('todo.human_work_accept', '验收通过')}
              </button>
              <button
                type="button"
                className={secondaryActionClassName}
                data-testid="human-issue-request-changes"
                disabled={busy}
                onClick={() => openForm('request_changes')}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t('todo.human_work_request_changes', '退回修改')}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {form ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            form === 'submit'
              ? t('todo.human_work_submit', '提交待确认')
              : t('todo.human_work_request_changes', '退回修改')
          }
          data-testid="human-issue-work-dialog"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <form
            className="w-full max-w-md rounded-xl bg-background p-5 shadow-lg"
            onSubmit={event => {
              event.preventDefault()
              if (text.trim() && !busy) void run(form)
            }}
          >
            <label className="block text-sm font-medium" htmlFor="human-issue-work-text">
              {form === 'submit'
                ? t('todo.human_work_summary', '处理结果')
                : t('todo.human_work_reason', '退回原因')}
            </label>
            <textarea
              id="human-issue-work-text"
              data-testid="human-issue-work-text"
              className="mt-3 min-h-28 w-full rounded-md border border-border bg-background p-3 text-sm"
              value={text}
              onChange={event => setText(event.target.value)}
              maxLength={form === 'submit' ? 100000 : 10000}
              required
              autoFocus
            />
            {error ? (
              <p role="alert" className="mt-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="human-issue-work-cancel"
                disabled={busy}
                onClick={() => setForm(null)}
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                type="submit"
                data-testid="human-issue-work-confirm"
                disabled={busy || !text.trim()}
                className="rounded-md bg-foreground px-3 py-2 text-background"
              >
                {t('common.confirm', '确认')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
      {error && !form ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </>
  )
}
