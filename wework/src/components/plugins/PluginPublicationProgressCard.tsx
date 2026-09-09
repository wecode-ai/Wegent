import { Check, Circle, ExternalLink, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  PluginPublicationRequestItem,
  PluginPublicationStage,
  PluginPublicationStatus,
} from '@/types/api'

interface PluginPublicationProgressCardProps {
  publication: PluginPublicationRequestItem
  withdrawing?: boolean
  onView: () => void
  onWithdraw?: () => void
  onCreateRevision?: () => void
  historyCount?: number
  onViewHistory?: () => void
}

const STAGES: Array<{ stage: PluginPublicationStage; key: string; fallback: string }> = [
  { stage: 'submit_request', key: 'submission', fallback: '提交申请' },
  { stage: 'automated_checks', key: 'automatic_checks', fallback: '自动检查' },
  { stage: 'administrator_review', key: 'administrator_review', fallback: '管理员审核' },
  { stage: 'code_review', key: 'code_review', fallback: '代码审核' },
  { stage: 'release', key: 'release', fallback: '发布' },
]

function publicationStatusLabel(
  status: PluginPublicationStatus,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const fallbacks: Record<PluginPublicationStatus, string> = {
    uploading: '正在上传',
    submitted: '已提交',
    automatic_checking: '自动检查中',
    automatic_check_failed: '自动检查未通过',
    awaiting_admin: '等待管理员审核',
    admin_review: '管理员审核中',
    changes_requested: '已退回修改',
    admin_accepted: '管理员已接受',
    materializing: '正在创建 MR',
    draft_mr_open: 'MR 已创建',
    ci_running: '代码检查中',
    code_changes_requested: '代码需修改',
    merge_ready: '等待合并',
    merged: '已合并',
    publishing: '正在发布',
    published: '已向企业全员发布',
    publish_failed: '发布失败',
    withdrawn: '已撤回',
    closed: '已关闭',
  }
  return t('workbench.plugins_publication_status_' + status, fallbacks[status])
}

function isFailure(status: PluginPublicationStatus): boolean {
  return [
    'automatic_check_failed',
    'changes_requested',
    'code_changes_requested',
    'publish_failed',
    'closed',
  ].includes(status)
}

export function PluginPublicationProgressCard({
  publication,
  withdrawing = false,
  onView,
  onWithdraw,
  onCreateRevision,
  historyCount = 0,
  onViewHistory,
}: PluginPublicationProgressCardProps) {
  const { t } = useTranslation('common')
  const activeIndex = STAGES.findIndex(item => item.stage === publication.stage)
  const published = publication.status === 'published'
  const failed = isFailure(publication.status)
  const version = publication.requestedVersion

  return (
    <section
      className="mt-7 space-y-4 rounded-2xl bg-surface px-4 py-4"
      data-testid={'plugin-publication-card-' + publication.id}
      aria-label={t('workbench.plugins_publication_progress', '企业全员发布进度')}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-text-primary">
            {t('workbench.plugins_publication_enterprise_release', '企业全员发布')} · v{version}
          </p>
          <p
            className={cn(
              'mt-1 text-xs',
              failed ? 'text-red-600' : published ? 'text-green-700' : 'text-text-muted'
            )}
          >
            {publicationStatusLabel(publication.status, t)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {onViewHistory && historyCount > 1 ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              data-testid={'plugin-publication-view-history-' + publication.id}
              onClick={onViewHistory}
            >
              {t('workbench.plugins_publication_request_history', '申请记录')} ({historyCount})
            </Button>
          ) : null}
          {onCreateRevision && publication.actionEligibility.canCreateRevision ? (
            <Button
              type="button"
              size="sm"
              data-testid={'plugin-publication-create-revision-' + publication.id}
              onClick={onCreateRevision}
            >
              {publication.status === 'changes_requested' ||
              publication.status === 'code_changes_requested'
                ? t('workbench.plugins_publication_fix_and_resubmit', '修复并重新提交')
                : t('workbench.plugins_publication_create_revision', '提交新修订版')}
            </Button>
          ) : null}
          {onWithdraw && publication.actionEligibility.canWithdraw ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="border-red-500/40 text-red-600 hover:border-red-500/60 hover:bg-red-500/10 hover:text-red-700"
              disabled={withdrawing}
              data-testid={'plugin-publication-withdraw-' + publication.id}
              onClick={onWithdraw}
            >
              <XCircle aria-hidden="true" />
              {withdrawing
                ? t('workbench.plugins_publication_withdrawing', '正在撤回…')
                : t('workbench.plugins_publication_withdraw', '撤回')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid={'plugin-publication-view-progress-' + publication.id}
            onClick={onView}
          >
            {published
              ? t('workbench.plugins_publication_view_enterprise', '查看企业版本')
              : t('workbench.plugins_publication_view_progress', '查看进度')}
            {published ? <ExternalLink /> : null}
          </Button>
        </div>
      </div>

      <ol
        className="grid grid-cols-1 gap-2 sm:grid-cols-5"
        aria-label={t('workbench.plugins_publication_progress_stages', '发布阶段')}
      >
        {STAGES.map((item, index) => {
          const complete = published || index < activeIndex
          const active = index === activeIndex && !published
          const stageFailed = active && failed
          const Icon = complete ? Check : stageFailed ? XCircle : Circle
          return (
            <li
              key={item.stage}
              className={cn(
                'flex items-center gap-2 text-xs sm:block',
                active ? 'text-text-primary' : 'text-text-muted'
              )}
              aria-current={active ? 'step' : undefined}
            >
              <div className="flex items-center">
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                    complete
                      ? 'bg-green-600/10 text-green-700'
                      : stageFailed
                        ? 'bg-red-500/10 text-red-600'
                        : active
                          ? 'bg-blue-500/10 text-blue-600'
                          : 'text-text-muted'
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </span>
                {index < STAGES.length - 1 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mx-1 hidden h-px flex-1 sm:block',
                      complete ? 'bg-green-600/30' : 'bg-border'
                    )}
                  />
                ) : null}
              </div>
              <span className="mt-1 block truncate">
                {t('workbench.plugins_publication_stage_' + item.key, item.fallback)}
              </span>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
