import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  ArrowUpRight,
  Bot,
  CalendarDays,
  Circle,
  CircleDot,
  Copy,
  Clock3,
  Ellipsis,
  Link2,
  Maximize2,
  Minimize2,
  Paperclip,
  PanelRight,
  Play,
  Target,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { buildRuntimeTaskRoute, toBrowserPath } from '@/lib/navigation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { Attachment, RuntimeGoal, RuntimeTaskAddress, RuntimeTaskSummary } from '@/types/api'

export type TodoViewState = 'backlog' | 'started' | 'review' | 'completed'

export interface TodoDetailItem {
  id: string
  code: string
  title: string
  state: TodoViewState
  runtime: string
  workspace: string
  kind: 'runtime' | 'draft'
  description?: string
  objective?: string
  priority?: string
  priorityValue?: 'none' | 'urgent' | 'high' | 'normal' | 'low'
  assignee?: string
  assigneeType?: 'unassigned' | 'ai' | 'human'
  dueDate?: string
  attachments?: Attachment[]
  createdAt?: string | number | null
  updatedAt?: string | number | null
  address?: RuntimeTaskAddress
  task?: RuntimeTaskSummary
}

interface TodoDetailPanelProps {
  item: TodoDetailItem
  userName?: string | null
  services?: WorkbenchServices
  onClose: () => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRun?: () => Promise<void> | void
  onDelete?: () => void
  onAttachmentsChange?: (attachments: Attachment[]) => void
}

const STATE_DETAILS: Record<TodoViewState, { labelKey: string; fallback: string; color: string }> =
  {
    backlog: { labelKey: 'todo.state_backlog', fallback: '待处理', color: '#858E97' },
    started: { labelKey: 'todo.state_started', fallback: '进行中', color: '#F59E0B' },
    review: { labelKey: 'todo.state_review', fallback: '待确认', color: '#8B5CF6' },
    completed: { labelKey: 'todo.state_completed', fallback: '已完成', color: '#10B981' },
  }

export function TodoDetailPanel({
  item,
  userName,
  services,
  onClose,
  onOpenRuntimeTask,
  onRun,
  onDelete,
  onAttachmentsChange,
}: TodoDetailPanelProps) {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [goal, setGoal] = useState<RuntimeGoal | null>(null)
  const [copied, setCopied] = useState(false)
  const [fullScreen, setFullScreen] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [runError, setRunError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const state = STATE_DETAILS[item.state]
  useEscapeKey(onClose, true)

  useEffect(() => {
    if (!item.address) return
    let cancelled = false
    void services?.runtimeWorkApi
      ?.getRuntimeGoal({ address: item.address })
      .then(response => {
        if (!cancelled && response.accepted) setGoal(response.goal)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [item.address, services?.runtimeWorkApi])

  const copyTaskLink = async () => {
    const content = item.address
      ? `${window.location.origin}${toBrowserPath(buildRuntimeTaskRoute(item.address))}`
      : [item.title, item.objective, item.description].filter(Boolean).join('\n\n')
    await copyTextToClipboard(content)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  const runTodo = async () => {
    if (!onRun || running) return
    setRunning(true)
    setRunError(null)
    try {
      await onRun()
    } catch (error) {
      setRunError(
        error instanceof Error ? error.message : t('todo.run_failed', 'TODO 运行失败，请重试')
      )
    } finally {
      setRunning(false)
    }
  }

  const addAttachment = async (file: File | undefined) => {
    if (!file || !onAttachmentsChange) return
    if (!services?.attachmentApi) {
      setAttachmentError(t('todo.attachments_unavailable', '附件服务当前不可用'))
      return
    }
    setUploading(true)
    setAttachmentError(null)
    try {
      const attachment = await services.attachmentApi.uploadAttachment(file)
      onAttachmentsChange([...(item.attachments ?? []), attachment])
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : t('todo.attachment_upload_failed', '附件上传失败')
      )
    } finally {
      setUploading(false)
    }
  }

  const removeAttachment = async (attachment: Attachment) => {
    if (!onAttachmentsChange) return
    setAttachmentError(null)
    try {
      await services?.attachmentApi?.deleteAttachment?.(attachment.id)
      onAttachmentsChange((item.attachments ?? []).filter(entry => entry.id !== attachment.id))
    } catch (error) {
      setAttachmentError(
        error instanceof Error ? error.message : t('todo.attachment_remove_failed', '附件移除失败')
      )
    }
  }

  return (
    <aside
      data-testid="todo-detail-panel"
      className={`absolute bottom-0 right-0 z-30 flex flex-col border-l border-[#D8DCE0] bg-white shadow-[-8px_0_22px_rgba(17,24,39,0.14)] transition-[left,width,top] dark:border-border dark:bg-background ${
        fullScreen ? 'left-0 top-0 w-full min-w-0' : 'top-[38px] w-1/2 min-w-[480px]'
      }`}
    >
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-[#E4E7E9] px-4 dark:border-border">
        <div className="flex items-center gap-3.5">
          <IconButton
            testId="todo-detail-close"
            label={t('workbench.close', '关闭')}
            icon={X}
            onClick={onClose}
          />
          {item.address && onOpenRuntimeTask && (
            <IconButton
              testId="todo-detail-open-fullscreen"
              label={t('todo.open_execution', '打开原任务页')}
              icon={Maximize2}
              onClick={() => void onOpenRuntimeTask(item.address!)}
            />
          )}
          <IconButton
            testId="todo-detail-preview-mode"
            label={fullScreen ? t('todo.side_view', '侧边查看') : t('todo.full_screen', '全屏查看')}
            icon={fullScreen ? Minimize2 : PanelRight}
            onClick={() => setFullScreen(value => !value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-[#8A9299]">
            {copied ? t('todo.copied', '已复制') : t('todo.saved', '已保存')}
          </span>
          <IconButton
            testId="todo-detail-copy-link"
            label={
              item.address ? t('todo.copy_link', '复制链接') : t('todo.copy_todo', '复制 TODO')
            }
            icon={item.address ? Link2 : Copy}
            bordered
            onClick={() => void copyTaskLink()}
          />
          <div className="relative">
            <IconButton
              testId="todo-detail-more"
              label={t('workbench.more', '更多')}
              icon={Ellipsis}
              bordered
              onClick={() => setMoreOpen(value => !value)}
            />
            {moreOpen && (
              <div
                data-testid="todo-detail-more-menu"
                className="absolute right-0 top-9 z-20 w-44 rounded-md border border-[#DDE1E4] bg-white p-1 shadow-lg dark:border-border dark:bg-background"
              >
                <DetailMenuButton
                  testId="todo-detail-menu-copy"
                  icon={item.address ? Link2 : Copy}
                  label={
                    item.address
                      ? t('todo.copy_link', '复制链接')
                      : t('todo.copy_todo', '复制 TODO')
                  }
                  onClick={() => {
                    setMoreOpen(false)
                    void copyTaskLink()
                  }}
                />
                {item.address && onOpenRuntimeTask && (
                  <DetailMenuButton
                    testId="todo-detail-menu-open"
                    icon={ArrowUpRight}
                    label={t('todo.open_execution', '打开原任务页')}
                    onClick={() => {
                      setMoreOpen(false)
                      void onOpenRuntimeTask(item.address!)
                    }}
                  />
                )}
                {onDelete && (
                  <DetailMenuButton
                    testId="todo-detail-menu-delete"
                    icon={Trash2}
                    label={t('todo.delete_todo', '删除 TODO')}
                    destructive
                    onClick={() => {
                      setMoreOpen(false)
                      onDelete()
                    }}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-[30px] py-[22px]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: state.color }} />
            <span className="font-mono text-xs font-semibold text-[#7F8890]">{item.code}</span>
            <span className="text-xs text-[#7F8890]">·</span>
            <span className="text-xs font-medium text-[#68717A]">
              {t(state.labelKey, state.fallback)}
            </span>
          </div>
          <span className="text-xs text-[#929AA1]">
            {t('todo.created_by', {
              defaultValue: '由 {{name}} 创建',
              name: userName || 'Wework',
            })}{' '}
            · {formatDetailDate(item.createdAt || item.updatedAt)}
          </span>
        </div>

        <h2 className="mt-4 text-heading-lg font-semibold leading-[1.25] text-[#202428] dark:text-text-primary">
          {item.title}
        </h2>

        <section className="mt-[18px]">
          <h3 className="text-xs font-semibold text-[#8A9299]">{t('todo.description', '描述')}</h3>
          <p className="mt-2 text-xs leading-6 text-[#4E565E] dark:text-text-secondary">
            {item.description ||
              item.task?.error ||
              t(
                'todo.runtime_task_description',
                '该工作项来自 Wework 原任务。打开原任务页可查看完整执行上下文与历史消息。'
              )}
          </p>
        </section>

        {(item.objective || goal?.objective) && (
          <section className="mt-[18px] flex gap-2 rounded-lg border border-[#CFECE7] bg-[#F2FAF8] p-3 dark:border-primary/20 dark:bg-primary/5">
            <Target className="mt-0.5 h-4 w-4 shrink-0 text-[#0F8F82]" />
            <p className="text-xs font-medium leading-[1.4] text-[#356A64] dark:text-primary">
              {t('todo.objective_prefix', '目标：')} {item.objective || goal?.objective}
            </p>
          </section>
        )}

        <section className="mt-[18px]">
          <h3 className="mb-2 text-sm font-semibold text-[#343A40] dark:text-text-primary">
            Properties
          </h3>
          <div className="space-y-1.5">
            <PropertyRow>
              <Property
                icon={CircleDot}
                label={t('todo.status', '状态')}
                value={t(state.labelKey, state.fallback)}
                valueColor={state.color}
              />
              <Property
                icon={Clock3}
                label={t('todo.priority', '优先级')}
                value={item.priority || t('todo.priority_normal', '普通')}
              />
            </PropertyRow>
            <PropertyRow>
              <Property
                icon={Bot}
                label={t('todo.assignee', '负责人')}
                value={item.assignee || item.runtime || 'AI'}
              />
              <Property
                icon={CalendarDays}
                label={t('todo.due_date', '截止时间')}
                value={item.dueDate || '—'}
              />
            </PropertyRow>
          </div>
        </section>

        <section className="mt-[18px]">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-[#41474D] dark:text-text-primary">
              {t('todo.attachments', '附件')}
            </h3>
            <button
              type="button"
              data-testid="todo-detail-add-attachment"
              onClick={() => fileInputRef.current?.click()}
              disabled={!onAttachmentsChange || uploading}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-[#68717A] hover:bg-[#F2F4F5] dark:hover:bg-muted"
            >
              <Paperclip className="h-3.5 w-3.5" />
              {uploading ? t('todo.uploading', '上传中…') : t('todo.add_attachment', '添加附件')}
            </button>
            <input
              ref={fileInputRef}
              data-testid="todo-detail-file-input"
              type="file"
              className="hidden"
              onChange={event => {
                void addAttachment(event.target.files?.[0])
                event.target.value = ''
              }}
            />
          </div>
          {item.attachments && item.attachments.length > 0 ? (
            <div className="mt-2 space-y-1.5">
              {item.attachments.map(attachment => (
                <div
                  key={attachment.id}
                  className="flex h-9 items-center gap-2 rounded-md border border-[#DDE1E4] px-3 text-xs text-[#68717A] dark:border-border"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span className="min-w-0 flex-1 truncate">{attachment.filename}</span>
                  {onAttachmentsChange && (
                    <button
                      type="button"
                      data-testid={`todo-detail-remove-attachment-${attachment.id}`}
                      onClick={() => void removeAttachment(attachment)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-[#F2F4F5] dark:hover:bg-muted"
                      aria-label={t('todo.remove_attachment', '移除附件')}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 flex h-10 items-center gap-2 rounded-md border border-dashed border-[#DDE1E4] px-3 text-xs text-[#929AA1] dark:border-border">
              <Paperclip className="h-3.5 w-3.5" />
              {t('todo.no_attachments', '暂无附件')}
            </div>
          )}
          {attachmentError && (
            <p data-testid="todo-detail-attachment-error" className="mt-2 text-xs text-destructive">
              {attachmentError}
            </p>
          )}
        </section>

        <section className="mt-[18px]">
          <h3 className="text-xs font-semibold text-[#41474D] dark:text-text-primary">Activity</h3>
          <div className="mt-2 flex items-start gap-2">
            <span className="mt-1.5 h-2 w-2 rounded-full bg-[#14B8A6]" />
            <div>
              <p className="text-xs text-[#596169] dark:text-text-secondary">
                {activityText(item, t)}
              </p>
              <p className="mt-1 text-xs text-[#929AA1]">{formatDetailDate(item.updatedAt)}</p>
            </div>
          </div>
        </section>
      </div>

      <footer className="flex min-h-[62px] shrink-0 items-center justify-between gap-3 border-t border-[#E1E4E7] px-4 py-2 dark:border-border">
        <div className="min-w-0 flex-1">
          {runError && (
            <div
              data-testid="todo-detail-run-error"
              className="flex min-w-0 items-start gap-2 rounded-md border border-[#F1D49D] bg-[#FFF7E8] px-2.5 py-2 text-xs text-[#8A5410]"
            >
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">{runError}</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {item.address && onOpenRuntimeTask && (
            <button
              type="button"
              data-testid="todo-detail-open-execution"
              onClick={() => void onOpenRuntimeTask(item.address!)}
              className="flex h-[34px] items-center gap-1.5 rounded-md border border-[#D8DCE0] bg-white px-3 text-xs font-semibold text-[#4F575F] hover:bg-[#F7F8F9] dark:border-border dark:bg-background dark:text-text-secondary dark:hover:bg-muted"
            >
              {t('todo.open_execution', '打开原任务页')}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
          )}
          {onRun && (
            <button
              type="button"
              data-testid="todo-detail-run"
              onClick={() => void runTodo()}
              disabled={running}
              className="flex h-[34px] items-center gap-1.5 rounded-md bg-[#14B8A6] px-3.5 text-xs font-bold text-white hover:bg-[#0FA797]"
            >
              <Play className="h-3.5 w-3.5 fill-current" />
              {running ? t('todo.running', '运行中…') : t('todo.run', '运行 TODO')}
            </button>
          )}
        </div>
      </footer>
    </aside>
  )
}

function DetailMenuButton({
  testId,
  icon: Icon,
  label,
  destructive = false,
  onClick,
}: {
  testId: string
  icon: typeof X
  label: string
  destructive?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className={`flex h-8 w-full items-center gap-2 rounded px-2 text-xs hover:bg-[#F2F4F5] dark:hover:bg-muted ${
        destructive ? 'text-destructive' : 'text-[#4F575F] dark:text-text-secondary'
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  )
}

function IconButton({
  testId,
  label,
  icon: Icon,
  bordered = false,
  onClick,
}: {
  testId: string
  label: string
  icon: typeof X
  bordered?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      title={label}
      aria-label={label}
      className={`flex h-7 w-7 items-center justify-center rounded-md text-[#68717A] hover:bg-[#F2F4F5] dark:hover:bg-muted ${
        bordered ? 'border border-[#E1E4E7] dark:border-border' : ''
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  )
}

function PropertyRow({ children }: { children: ReactNode }) {
  return <div className="grid h-[38px] grid-cols-2 gap-3">{children}</div>
}

function Property({
  icon: Icon,
  label,
  value,
  valueColor,
}: {
  icon: typeof Circle
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <div className="flex min-w-0 items-center justify-between rounded-md bg-[#F7F8F9] px-2.5 dark:bg-muted">
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-[#7A838B]">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
      <span className="ml-2 truncate text-xs font-medium text-[#4F575F] dark:text-text-secondary">
        {valueColor && (
          <span
            className="mr-1.5 inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: valueColor }}
          />
        )}
        {value}
      </span>
    </div>
  )
}

function formatDetailDate(value: string | number | null | undefined): string {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function activityText(item: TodoDetailItem, t: ReturnType<typeof useTranslation>['t']): string {
  if (item.state === 'completed') return t('todo.activity_completed', '任务已完成并同步到 TODO')
  if (item.state === 'review') return t('todo.activity_review', '任务正在等待确认')
  if (item.state === 'started') return t('todo.activity_started', '任务正在运行')
  return t('todo.activity_created', 'TODO 已创建')
}
