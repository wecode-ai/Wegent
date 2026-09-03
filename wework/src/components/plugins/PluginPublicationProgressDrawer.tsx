import { Check, Circle, ExternalLink, FileWarning, RotateCcw, X, XCircle } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { formatUTC8DateTime } from '@/lib/utc-date'
import { cn } from '@/lib/utils'
import type {
  PluginPublicationCheckItem,
  PluginPublicationRequestItem,
  PluginPublicationStatus,
} from '@/types/api'

interface PluginPublicationProgressDrawerProps {
  publication: PluginPublicationRequestItem
  loading?: boolean
  withdrawing?: boolean
  onClose: () => void
  onRefresh: () => void
  onWithdraw?: () => void
  onCreateRevision?: () => void
  onViewEnterprise?: () => void
  requestHistory?: PluginPublicationRequestItem[]
  onSelectRequest?: (requestId: number) => void
  onSelectRevision?: (revisionNumber: number) => void
}

function statusTone(status: PluginPublicationStatus): 'normal' | 'warning' | 'error' | 'success' {
  if (status === 'published') return 'success'
  if (status === 'changes_requested' || status === 'code_changes_requested') return 'warning'
  if (status === 'automatic_check_failed' || status === 'publish_failed' || status === 'closed') {
    return 'error'
  }
  return 'normal'
}

function checkTone(check: PluginPublicationCheckItem) {
  if (check.status === 'passed') return 'text-green-700 bg-green-600/10'
  if (check.status === 'failed' || check.status === 'blocked') return 'text-red-600 bg-red-500/10'
  if (check.status === 'not_run') return 'text-orange-700 bg-orange-500/10'
  return 'text-blue-600 bg-blue-500/10'
}

export function PluginPublicationProgressDrawer({
  publication,
  loading = false,
  withdrawing = false,
  onClose,
  onRefresh,
  onWithdraw,
  onCreateRevision,
  onViewEnterprise,
  requestHistory = [],
  onSelectRequest,
  onSelectRevision,
}: PluginPublicationProgressDrawerProps) {
  const { t } = useTranslation('common')
  const [confirmingWithdraw, setConfirmingWithdraw] = useState(false)
  const drawerRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const onCloseRef = useRef(onClose)
  const revision = publication.revision
  const revisionHistory = [...publication.revisions].sort(
    (left, right) => right.number - left.number
  )
  const tone = statusTone(publication.status)
  const latestRequiredChanges = [...publication.events]
    .reverse()
    .find(event => event.requiredChanges?.length)?.requiredChanges
  const localizedCheckTitle = (check: PluginPublicationCheckItem) => {
    const suffix = check.checkCode.replaceAll('.', '_')
    return t(`workbench.plugins_publication_check_${suffix}`, check.checkCode)
  }
  const localizedCheckSummary = (check: PluginPublicationCheckItem) =>
    t(`workbench.plugins_publication_check_summary_${check.status}`, check.status)
  const localizedCheckStatus = (status: PluginPublicationCheckItem['status']) =>
    t(`workbench.plugins_publication_check_status_${status}`, status)
  const localizedEventMessage = (event: PluginPublicationRequestItem['events'][number]) => {
    if (event.eventType === 'gitlab.merge_request_closed') {
      return event.actorName
        ? t('workbench.plugins_publication_mr_closed_by', {
            actor: event.actorName,
          })
        : t('workbench.plugins_publication_mr_closed_no_actor')
    }
    const label = t(
      `workbench.plugins_publication_event_${event.eventType.replaceAll('.', '_')}`,
      event.eventType
    )
    return event.eventType === 'admin.changes_requested' && event.message
      ? `${label}：${event.message}`
      : label
  }
  const localizedFailureReason = (reason?: string | null, status?: string) => {
    if (!reason) {
      return t(
        `workbench.plugins_publication_pipeline_failure_reason_${status || 'failed'}`,
        status || 'failed'
      )
    }
    return t(
      `workbench.plugins_publication_pipeline_failure_reason_${reason.replaceAll('.', '_')}`,
      reason
    )
  }

  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeButtonRef.current?.focus()
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCloseRef.current()
    }
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('keydown', handleEscape)
      previousFocus?.focus()
    }
  }, [])

  const trapDrawerFocus = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      drawerRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    )
    if (focusable.length === 0) return
    const currentIndex = focusable.indexOf(document.activeElement as HTMLElement)
    const nextIndex = event.shiftKey
      ? currentIndex <= 0
        ? focusable.length - 1
        : currentIndex - 1
      : currentIndex === focusable.length - 1
        ? 0
        : currentIndex + 1
    event.preventDefault()
    focusable[nextIndex]?.focus()
  }

  return (
    <div
      data-testid="plugin-publication-progress-overlay"
      className="plugin-dialog-overlay fixed inset-0 z-modal flex justify-end"
      onClick={event => {
        if (
          !loading &&
          !withdrawing &&
          !confirmingWithdraw &&
          event.target === event.currentTarget
        ) {
          onClose()
        }
      }}
    >
      <section
        ref={drawerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-publication-progress-title"
        data-testid="plugin-publication-progress-drawer"
        className="flex h-full w-full max-w-[520px] flex-col border-l border-border/30 bg-background shadow-xl"
        onKeyDown={trapDrawerFocus}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border/25 px-5 py-5">
          <div>
            <h2 id="plugin-publication-progress-title" className="heading-small text-text-primary">
              {t('workbench.plugins_publication_progress', '企业全员发布进度')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {publication.pluginName} · v{revision.requestedVersion} ·{' '}
              {t('workbench.plugins_publication_revision', '修订版')} {revision.number}
            </p>
          </div>
          <Button
            ref={closeButtonRef}
            type="button"
            size="icon"
            variant="ghost"
            data-testid="plugin-publication-progress-close"
            aria-label={t('common.close', '关闭')}
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
          {requestHistory.length > 1 ? (
            <section className="space-y-3" data-testid="plugin-publication-request-history">
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.plugins_publication_request_history', '申请记录')}
              </h3>
              <ul className="overflow-hidden rounded-xl border border-border/30">
                {requestHistory.map(item => (
                  <li key={item.id} className="border-b border-border/25 last:border-b-0">
                    <button
                      type="button"
                      className={cn(
                        'flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-sm hover:bg-surface',
                        item.id === publication.id && 'bg-surface'
                      )}
                      data-testid={'plugin-publication-request-' + item.id}
                      aria-current={item.id === publication.id ? 'true' : undefined}
                      onClick={() => onSelectRequest?.(item.id)}
                    >
                      <span className="font-medium text-text-primary">
                        #{item.id} · v{item.requestedVersion}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t('workbench.plugins_publication_status_' + item.status, item.status)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.plugins_publication_current_status', '当前状态')}
              </h3>
              <span
                className={cn(
                  'rounded-full px-2.5 py-1 text-xs',
                  tone === 'success'
                    ? 'bg-green-600/10 text-green-700'
                    : tone === 'error'
                      ? 'bg-red-500/10 text-red-600'
                      : tone === 'warning'
                        ? 'bg-orange-500/10 text-orange-700'
                        : 'bg-blue-500/10 text-blue-600'
                )}
              >
                {t(
                  'workbench.plugins_publication_status_' + publication.status,
                  publication.status
                )}
              </span>
            </div>
            <dl className="overflow-hidden rounded-xl border border-border/30 text-sm">
              {[
                [t('workbench.plugins_publication_request_id', '申请编号'), String(publication.id)],
                [t('workbench.plugins_publication_revision', '修订版'), String(revision.number)],
                [
                  t('workbench.plugins_publication_confirm_version', '版本'),
                  revision.requestedVersion,
                ],
                [t('workbench.plugins_publication_sha256', 'SHA256'), revision.snapshotSha256],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-b border-border/25 px-3 py-3 last:border-b-0"
                >
                  <dt className="text-text-muted">{label}</dt>
                  <dd className="break-all text-text-primary">{value || '-'}</dd>
                </div>
              ))}
            </dl>
          </section>

          {latestRequiredChanges?.length ? (
            <section
              className="space-y-3 rounded-xl border border-orange-500/25 bg-orange-500/5 px-4 py-4"
              data-testid="plugin-publication-required-changes"
            >
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.plugins_publication_required_changes', '需要修改')}
              </h3>
              <ul className="list-disc space-y-1 pl-5 text-sm leading-5 text-text-secondary">
                {latestRequiredChanges.map(item => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="space-y-3" data-testid="plugin-publication-revision-history">
            <h3 className="text-sm font-medium text-text-primary">
              {t('workbench.plugins_publication_revision_history', '版本记录')}
            </h3>
            <ul className="overflow-hidden rounded-xl border border-border/30">
              {revisionHistory.map(item => (
                <li key={item.id} className="border-b border-border/25 last:border-b-0">
                  <button
                    type="button"
                    data-testid={'plugin-publication-revision-' + item.number}
                    aria-current={item.number === revision.number ? 'true' : undefined}
                    className={cn(
                      'w-full px-3 py-3 text-left text-sm hover:bg-surface',
                      item.number === revision.number && 'bg-surface'
                    )}
                    onClick={() => onSelectRevision?.(item.number)}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="font-medium text-text-primary">
                        {t('workbench.plugins_publication_revision', '修订版')} {item.number} · v
                        {item.requestedVersion}
                      </span>
                      <span className="text-xs text-text-muted">
                        {t('workbench.plugins_publication_status_' + item.status, item.status)}
                      </span>
                    </span>
                    <span className="mt-1 block break-all font-mono text-xs leading-4 text-text-muted">
                      {item.snapshotSha256}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-text-primary">
              {t('workbench.plugins_publication_checks', '检查结果')}
            </h3>
            {publication.checks.length > 0 ? (
              <ul className="space-y-2" data-testid="plugin-publication-progress-checks">
                {publication.checks.map(check => (
                  <li
                    key={check.id}
                    className="flex items-start gap-3 rounded-xl border border-border/30 px-3 py-3"
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                        checkTone(check)
                      )}
                    >
                      {check.status === 'passed' ? (
                        <Check className="h-4 w-4" />
                      ) : check.status === 'pending' || check.status === 'running' ? (
                        <Circle className="h-4 w-4" />
                      ) : (
                        <FileWarning className="h-4 w-4" />
                      )}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-text-primary">
                          {localizedCheckTitle(check)}
                        </p>
                        <span className="font-mono text-xs text-text-muted">{check.checkCode}</span>
                        <span className="text-xs text-text-muted">
                          {localizedCheckStatus(check.status)}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-4 text-text-secondary">
                        {localizedCheckSummary(check)}
                      </p>
                      {check.evidence.length > 0 ? (
                        <ul
                          className="mt-2 space-y-1 text-xs leading-4 text-text-secondary"
                          data-testid={'plugin-publication-check-evidence-list-' + check.id}
                        >
                          {check.evidence.map((item, index) => (
                            <li key={index} className="break-words">
                              {item}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {check.jobUrl ? (
                        <a
                          href={check.jobUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                          data-testid={'plugin-publication-check-evidence-' + check.id}
                        >
                          {t('workbench.plugins_publication_view_evidence', '查看证据')}
                          <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="rounded-xl bg-surface px-3 py-3 text-sm text-text-muted">
                {t('workbench.plugins_publication_checks_pending', '检查结果生成后会显示在这里。')}
              </p>
            )}
          </section>

          {publication.gitlab ? (
            <section className="space-y-3">
              <h3 className="text-sm font-medium text-text-primary">GitLab</h3>
              <div className="rounded-xl border border-border/30 px-3 py-3 text-sm">
                <p className="text-text-secondary">
                  {publication.gitlab.sourceBranch || '-'} ·{' '}
                  {publication.gitlab.pipelineStatus || publication.status}
                </p>
                <div className="mt-2 flex flex-wrap gap-3">
                  {publication.gitlab.mergeRequestUrl ? (
                    <a
                      href={publication.gitlab.mergeRequestUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      data-testid="plugin-publication-progress-mr-link"
                    >
                      {t('workbench.plugins_publication_open_mr', '打开 MR')}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                  {publication.gitlab.pipelineUrl ? (
                    <a
                      href={publication.gitlab.pipelineUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                      data-testid="plugin-publication-progress-pipeline-link"
                    >
                      {t('workbench.plugins_publication_open_pipeline', '查看 Pipeline')}
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <section className="space-y-3">
            <h3 className="text-sm font-medium text-text-primary">
              {t('workbench.plugins_publication_timeline', '时间线')}
            </h3>
            <ol className="space-y-3" data-testid="plugin-publication-progress-events">
              {publication.events.map(event => (
                <li key={event.id} className="grid grid-cols-[14px_minmax(0,1fr)] gap-3">
                  <span className="mt-1.5 h-2 w-2 rounded-full bg-border" aria-hidden="true" />
                  <div>
                    <p className="text-sm text-text-primary">{localizedEventMessage(event)}</p>
                    {event.requiredChanges?.length ? (
                      <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-text-secondary">
                        {event.requiredChanges.map(item => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    ) : null}
                    {event.failureDetails?.length ? (
                      <ul
                        className="mt-2 space-y-2"
                        data-testid={`plugin-publication-event-failures-${event.id}`}
                      >
                        {event.failureDetails.map((failure, index) => (
                          <li
                            key={`${failure.jobName}-${failure.stage || ''}-${index}`}
                            className="rounded-lg border border-border/40 bg-surface-secondary px-3 py-2"
                          >
                            <p className="text-xs font-medium text-text-primary">
                              {failure.jobName}
                              {failure.stage ? ` · ${failure.stage}` : ''}
                            </p>
                            <p className="mt-0.5 text-xs text-text-secondary">
                              {localizedFailureReason(failure.reason, failure.status)}
                            </p>
                            {failure.jobUrl ? (
                              <a
                                href={failure.jobUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="mt-1 inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                                data-testid={`plugin-publication-failed-job-${event.id}-${index}`}
                              >
                                {t('workbench.plugins_publication_open_failed_job')}
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <p className="mt-0.5 text-xs text-text-muted">
                      {formatUTC8DateTime(event.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <footer className="border-t border-border/25 bg-background px-5 py-4">
          {confirmingWithdraw && onWithdraw ? (
            <div className="space-y-3" data-testid="plugin-publication-withdraw-confirmation">
              <p className="text-sm leading-5 text-text-secondary">
                {t(
                  'workbench.plugins_publication_withdraw_confirm',
                  '撤回后，尚未合并的 MR 会一并关闭；当前修订版和审核记录仍会保留。'
                )}
              </p>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  data-testid="plugin-publication-withdraw-cancel"
                  disabled={withdrawing}
                  onClick={() => setConfirmingWithdraw(false)}
                >
                  {t('common.cancel', '取消')}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  disabled={withdrawing}
                  data-testid="plugin-publication-withdraw-confirm"
                  onClick={onWithdraw}
                >
                  {withdrawing
                    ? t('workbench.plugins_publication_withdrawing', '正在撤回…')
                    : t('workbench.plugins_publication_confirm_withdraw', '确认撤回')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <Button
                type="button"
                variant="ghost"
                data-testid="plugin-publication-progress-refresh"
                disabled={loading}
                onClick={onRefresh}
              >
                <RotateCcw className={cn(loading && 'animate-spin')} />
                {t('common.refresh', '刷新')}
              </Button>
              <div className="flex items-center gap-2">
                {onWithdraw && publication.actionEligibility.canWithdraw ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="border-red-500/40 text-red-600 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-700"
                    disabled={withdrawing}
                    data-testid="plugin-publication-progress-withdraw"
                    onClick={() => setConfirmingWithdraw(true)}
                  >
                    <XCircle aria-hidden="true" />
                    {t('workbench.plugins_publication_withdraw', '撤回申请')}
                  </Button>
                ) : null}
                {onCreateRevision && publication.actionEligibility.canCreateRevision ? (
                  <Button
                    type="button"
                    data-testid="plugin-publication-progress-create-revision"
                    onClick={onCreateRevision}
                  >
                    {publication.status === 'changes_requested' ||
                    publication.status === 'code_changes_requested'
                      ? t('workbench.plugins_publication_fix_and_resubmit', '修复并重新提交')
                      : t('workbench.plugins_publication_create_revision', '提交新修订版')}
                  </Button>
                ) : null}
                {onViewEnterprise && publication.actionEligibility.canViewEnterprisePlugin ? (
                  <Button
                    type="button"
                    data-testid="plugin-publication-progress-view-enterprise"
                    onClick={onViewEnterprise}
                  >
                    {t('workbench.plugins_publication_view_enterprise', '查看企业版本')}
                    <ExternalLink />
                  </Button>
                ) : null}
              </div>
              {(!onWithdraw || !publication.actionEligibility.canWithdraw) &&
              (!onCreateRevision || !publication.actionEligibility.canCreateRevision) &&
              (!onViewEnterprise || !publication.actionEligibility.canViewEnterprisePlugin) ? (
                <Button
                  type="button"
                  data-testid="plugin-publication-progress-done"
                  onClick={onClose}
                >
                  {t('common.close', '关闭')}
                </Button>
              ) : null}
            </div>
          )}
        </footer>
      </section>
    </div>
  )
}
