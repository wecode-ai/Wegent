import { useRef, useState } from 'react'
import { CircleCheck, Loader2, RotateCcw, Sparkles } from 'lucide-react'
import type { CloudLoopItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'

type DeliveryApi = NonNullable<WorkbenchServices['deliveryApi']>
type HumanWorkApi = Pick<
  DeliveryApi,
  | 'getLoopItem'
  | 'getDelivery'
  | 'startHumanIssueWork'
  | 'submitHumanIssueWork'
  | 'reviewHumanIssueWork'
>

interface HumanIssueWorkPanelProps {
  item: CloudLoopItem
  api: HumanWorkApi
  onUpdated: (item: CloudLoopItem) => void
  onAiAssist?: () => void
}

const primaryAction =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40'
const secondaryAction =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2.5 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40'

export function HumanIssueWorkPanel({
  item,
  api,
  onUpdated,
  onAiAssist,
}: HumanIssueWorkPanelProps) {
  const { t } = useTranslation('common')
  const work = item.human_work
  const [result, setResult] = useState(work?.result ?? '')
  const [reason, setReason] = useState('')
  const [dialog, setDialog] = useState<'submit' | 'return' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestId = useRef<{ key: string; value: string } | null>(null)

  if (!work) return null

  const stableRequestId = (key: string) => {
    if (requestId.current?.key !== key) {
      requestId.current = { key, value: crypto.randomUUID() }
    }
    return requestId.current.value
  }

  const insertAiDraft = async () => {
    if (!work.ai_draft_delivery_id || busy) return
    setBusy(true)
    setError(null)
    try {
      const delivery = await api.getDelivery(work.ai_draft_delivery_id)
      setResult(delivery.markdown)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.human_work_failed'))
    } finally {
      setBusy(false)
    }
  }

  const run = async (action: 'start' | 'submit' | 'accept' | 'request_changes') => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response =
        action === 'start'
          ? await api.startHumanIssueWork(item.id, item.version)
          : action === 'submit'
            ? await api.submitHumanIssueWork(
                item.id,
                item.version,
                result.trim(),
                stableRequestId(`submit:${item.id}:${result.trim()}`)
              )
            : await api.reviewHumanIssueWork(
                item.id,
                item.version,
                action,
                stableRequestId(`review:${item.id}:${action}:${reason.trim()}`),
                action === 'request_changes' ? reason.trim() : undefined
              )
      onUpdated(response.issue)
      requestId.current = null
      setDialog(null)
      setReason('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('todo.human_work_failed'))
      try {
        onUpdated(await api.getLoopItem(item.id))
      } catch {
        // Keep the draft visible for a later retry after reconnecting.
      }
    } finally {
      setBusy(false)
    }
  }

  const showResult = Boolean(work.result) && !work.can_submit

  return (
    <section data-testid="human-issue-work-panel" className="mt-5 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-text-primary">{t('todo.human_work_title')}</h3>
        <span className="text-xs text-text-muted">
          {work.state === 'submitted'
            ? t('todo.human_work_waiting_review')
            : work.state === 'accepted'
              ? t('todo.human_work_accepted')
              : work.state === 'changes_requested'
                ? t('todo.human_work_returned')
                : item.status === 'in_progress'
                  ? t('todo.human_work_in_progress')
                  : t('todo.human_work_pending')}
        </span>
      </div>

      {work.return_reason ? (
        <p
          data-testid="human-issue-return-reason"
          className="mt-3 rounded-lg bg-muted px-3 py-2 text-sm text-text-secondary"
        >
          {t('todo.human_work_reason')}：{work.return_reason}
        </p>
      ) : null}

      {work.can_start ? (
        <div className="mt-3">
          <p className="mb-3 text-sm text-text-secondary">{t('todo.human_work_start_hint')}</p>
          <button
            type="button"
            data-testid="human-issue-start"
            className={primaryAction}
            disabled={busy}
            onClick={() => void run('start')}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {t('todo.human_work_start')}
          </button>
        </div>
      ) : null}

      {work.can_submit ? (
        <div className="mt-3">
          {work.ai_draft_delivery_id ? (
            <div className="mb-3 flex items-center justify-between gap-2 rounded-lg bg-muted px-3 py-2 text-sm">
              <span className="text-text-secondary">{t('todo.human_work_ai_draft_ready')}</span>
              <button
                type="button"
                data-testid="human-issue-use-ai-draft"
                className={secondaryAction}
                disabled={busy}
                onClick={() => void insertAiDraft()}
              >
                {t('todo.human_work_use_ai_draft')}
              </button>
            </div>
          ) : null}
          <label
            htmlFor="human-issue-result"
            className="block text-sm font-medium text-text-primary"
          >
            {t('todo.human_work_result')}
          </label>
          <textarea
            id="human-issue-result"
            data-testid="human-issue-result"
            className="mt-2 min-h-32 w-full resize-y rounded-lg border border-border bg-background p-3 text-sm text-text-primary outline-none focus-visible:border-focus"
            placeholder={t('todo.human_work_result_placeholder')}
            value={result}
            onChange={event => setResult(event.target.value)}
            maxLength={100000}
            disabled={busy}
          />
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            {onAiAssist ? (
              <button
                type="button"
                data-testid="human-issue-ai-assist"
                className={secondaryAction}
                disabled={busy}
                onClick={onAiAssist}
              >
                <Sparkles className="h-4 w-4" />
                {t('todo.human_work_ai_assist')}
              </button>
            ) : null}
            <button
              type="button"
              data-testid="human-issue-submit"
              className={primaryAction}
              disabled={busy || !result.trim()}
              onClick={() => setDialog('submit')}
            >
              {t('todo.human_work_submit')}
            </button>
          </div>
        </div>
      ) : null}

      {showResult ? (
        <div className="mt-3">
          <p className="text-xs text-text-muted">{t('todo.human_work_result')}</p>
          <p
            data-testid="human-issue-submitted-result"
            className="mt-1 whitespace-pre-wrap text-sm text-text-primary"
          >
            {work.result}
          </p>
        </div>
      ) : null}

      {work.can_review ? (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            data-testid="human-issue-request-changes"
            className={secondaryAction}
            disabled={busy}
            onClick={() => setDialog('return')}
          >
            <RotateCcw className="h-4 w-4" />
            {t('todo.human_work_request_changes')}
          </button>
          <button
            type="button"
            data-testid="human-issue-accept"
            className={primaryAction}
            disabled={busy}
            onClick={() => void run('accept')}
          >
            <CircleCheck className="h-4 w-4" />
            {t('todo.human_work_accept')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {dialog ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={
            dialog === 'submit' ? t('todo.human_work_submit') : t('todo.human_work_request_changes')
          }
          data-testid="human-issue-work-dialog"
          className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-2xl bg-background p-5 shadow-lg">
            <h3 className="text-heading-sm font-medium">
              {dialog === 'submit'
                ? t('todo.human_work_submit')
                : t('todo.human_work_request_changes')}
            </h3>
            {dialog === 'submit' ? (
              <div className="mt-3 rounded-lg bg-muted p-3 text-sm">
                <p className="text-xs text-text-muted">{t('todo.human_work_result')}</p>
                <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-text-primary">
                  {result.trim()}
                </p>
              </div>
            ) : (
              <label className="mt-3 block text-sm">
                <span className="font-medium">{t('todo.human_work_reason')}</span>
                <textarea
                  data-testid="human-issue-return-reason-input"
                  className="mt-2 min-h-28 w-full resize-y rounded-lg border border-border bg-background p-3 outline-none focus-visible:border-focus"
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                  maxLength={10000}
                  autoFocus
                />
              </label>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                data-testid="human-issue-work-cancel"
                className={secondaryAction}
                disabled={busy}
                onClick={() => setDialog(null)}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                data-testid="human-issue-work-confirm"
                className={primaryAction}
                disabled={busy || (dialog === 'return' && !reason.trim())}
                onClick={() => void run(dialog === 'submit' ? 'submit' : 'request_changes')}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}
