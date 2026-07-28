import { invoke } from '@tauri-apps/api/core'
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FileText,
  Image as ImageIcon,
  ListChecks,
  Monitor,
  ScrollText,
  ShieldAlert,
  Loader2,
  X,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

type FeedbackCategory = 'report' | 'logs' | 'task' | 'system' | 'screenshot' | 'other'

interface FeedbackSelection {
  runtimeLogs: boolean
  taskInfo: boolean
  screenshot: boolean
  systemInfo: boolean
}

interface FeedbackExportResult {
  reportId: string
  path: string
}

interface FeedbackEntryPreview {
  category: string
  archivePath: string
  sizeBytes: number
  previewable: boolean
  content: string | null
  truncated: boolean
}

interface FeedbackPreviewResult {
  stagingId: string
  reportId: string
  entries: FeedbackEntryPreview[]
  skipped: string[]
  warnings: string[]
  finalFileName: string
}

interface TaskFeedbackDialogProps {
  open: boolean
  hasActiveTask: boolean
  getTaskContext: () => Promise<Record<string, unknown>>
  onClose: () => void
}

type DialogPhase = 'configure' | 'preview' | 'done'

interface FeedbackOptionGroup {
  label: string
  description: string
  sensitive: boolean
  icon: typeof FileText
  options: readonly {
    key: keyof FeedbackSelection
    label: string
    description: string
    taskScoped: boolean
  }[]
}

// Full task data contains verbatim conversation history and a window
// screenshot. Free text cannot be reliably redacted, so it stays off by
// default and is labeled as a privacy risk instead of being masked.
const fullTaskSelection: FeedbackSelection = {
  runtimeLogs: true,
  taskInfo: true,
  screenshot: true,
  systemInfo: true,
}

const standardSelection: FeedbackSelection = {
  runtimeLogs: true,
  taskInfo: false,
  screenshot: false,
  systemInfo: true,
}

const noSelection: FeedbackSelection = {
  runtimeLogs: false,
  taskInfo: false,
  screenshot: false,
  systemInfo: false,
}

export function TaskFeedbackDialog({
  open,
  hasActiveTask,
  getTaskContext,
  onClose,
}: TaskFeedbackDialogProps) {
  if (!open) return null
  return (
    <TaskFeedbackDialogContent
      hasActiveTask={hasActiveTask}
      getTaskContext={getTaskContext}
      onClose={onClose}
    />
  )
}

function TaskFeedbackDialogContent({
  hasActiveTask,
  getTaskContext,
  onClose,
}: Omit<TaskFeedbackDialogProps, 'open'>) {
  const { t, i18n } = useTranslation('common')
  const [selection, setSelection] = useState<FeedbackSelection>(standardSelection)
  const [note, setNote] = useState('')
  const [exporting, setExporting] = useState(false)
  const [capturingScreenshot, setCapturingScreenshot] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<DialogPhase>('configure')
  const [preview, setPreview] = useState<FeedbackPreviewResult | null>(null)
  const [result, setResult] = useState<FeedbackExportResult | null>(null)
  const [expandedCategory, setExpandedCategory] = useState<FeedbackCategory | null>(null)
  const [expandedEntry, setExpandedEntry] = useState<string | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const hasSelection = Object.values(selection).some(Boolean)

  const discardPreview = async () => {
    if (!preview) return
    try {
      await invoke('discard_feedback_bundle', {
        decision: { stagingId: preview.stagingId },
      })
    } catch {
      // Staging cleanup is best-effort; the OS cache eventually reclaims it.
    }
  }

  const handleClose = () => {
    if (phase === 'preview') void discardPreview()
    onClose()
  }

  useEscapeKey(exporting ? () => undefined : handleClose)

  const buildPreview = async () => {
    setExporting(true)
    setError(null)
    try {
      // A checked category whose content turns out to be missing is skipped
      // by the backend instead of failing the whole export.
      let taskContext: Record<string, unknown> | null = null
      if (selection.taskInfo) {
        try {
          taskContext = await getTaskContext()
        } catch {
          taskContext = null
        }
      }
      let screenshotDataUrl: string | null = null
      if (selection.screenshot) {
        const overlay = overlayRef.current
        overlay?.style.setProperty('visibility', 'hidden')
        setCapturingScreenshot(true)
        await waitForScreenshotPaint()
        try {
          screenshotDataUrl = await invoke<string>('capture_main_webview')
        } catch {
          screenshotDataUrl = null
        } finally {
          overlay?.style.removeProperty('visibility')
          setCapturingScreenshot(false)
        }
      }
      const prepared = await invoke<FeedbackPreviewResult>('preview_feedback_bundle', {
        request: {
          includeRuntimeLogs: selection.runtimeLogs,
          includeTaskInfo: selection.taskInfo,
          includeScreenshot: selection.screenshot,
          includeSystemInfo: selection.systemInfo,
          note,
          taskContext,
          screenshotDataUrl,
        },
      })
      setPreview(prepared)
      setPhase('preview')
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError || t('workbench.feedback_export_failed'))
      )
    } finally {
      setExporting(false)
    }
  }

  const confirmExport = async () => {
    if (!preview) return
    setExporting(true)
    setError(null)
    try {
      const exported = await invoke<FeedbackExportResult>('confirm_feedback_bundle', {
        decision: { stagingId: preview.stagingId },
      })
      setResult(exported)
      setPhase('done')
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : String(caughtError || t('workbench.feedback_export_failed'))
      )
    } finally {
      setExporting(false)
    }
  }

  const backToConfigure = async () => {
    await discardPreview()
    setPreview(null)
    setExpandedCategory(null)
    setExpandedEntry(null)
    setPhase('configure')
  }

  const optionGroups: FeedbackOptionGroup[] = [
    {
      label: t('workbench.feedback_group_standard'),
      description: t('workbench.feedback_group_standard_description'),
      sensitive: false,
      icon: ListChecks,
      options: [
        {
          key: 'runtimeLogs',
          label: t('workbench.feedback_runtime_logs'),
          description: t('workbench.feedback_runtime_logs_description'),
          taskScoped: false,
        },
        {
          key: 'systemInfo',
          label: t('workbench.feedback_system_info'),
          description: t('workbench.feedback_system_info_description'),
          taskScoped: false,
        },
      ],
    },
    {
      label: t('workbench.feedback_group_full_task'),
      description: t('workbench.feedback_group_full_task_description'),
      sensitive: true,
      icon: ShieldAlert,
      options: [
        {
          key: 'taskInfo',
          label: t('workbench.feedback_task_info'),
          description: t('workbench.feedback_task_info_description'),
          taskScoped: true,
        },
        {
          key: 'screenshot',
          label: t('workbench.feedback_screenshot'),
          description: t('workbench.feedback_screenshot_description'),
          taskScoped: true,
        },
      ],
    },
  ]

  const categoryOrder: {
    key: FeedbackCategory
    label: string
    description: string
    sensitive: boolean
    icon: typeof FileText
  }[] = [
    {
      key: 'report',
      label: t('workbench.feedback_category_report'),
      description: t('workbench.feedback_category_report_description'),
      sensitive: false,
      icon: ListChecks,
    },
    {
      key: 'logs',
      label: t('workbench.feedback_runtime_logs'),
      description: t('workbench.feedback_runtime_logs_description'),
      sensitive: false,
      icon: ScrollText,
    },
    {
      key: 'system',
      label: t('workbench.feedback_system_info'),
      description: t('workbench.feedback_system_info_description'),
      sensitive: false,
      icon: Monitor,
    },
    {
      key: 'task',
      label: t('workbench.feedback_task_info'),
      description: t('workbench.feedback_task_info_preview_description'),
      sensitive: true,
      icon: FileText,
    },
    {
      key: 'screenshot',
      label: t('workbench.feedback_screenshot'),
      description: t('workbench.feedback_screenshot_preview_description'),
      sensitive: true,
      icon: ImageIcon,
    },
  ]

  const groupedPreview = preview
    ? categoryOrder
        .map(group => ({
          ...group,
          entries: preview.entries.filter(entry => entry.category === group.key),
        }))
        .filter(group => group.entries.length > 0)
    : []

  const skippedLabels = preview
    ? preview.skipped.map(category => {
        const labelKey = {
          runtimeLogs: 'workbench.feedback_runtime_logs',
          taskInfo: 'workbench.feedback_task_info',
          screenshot: 'workbench.feedback_screenshot',
          systemInfo: 'workbench.feedback_system_info',
        }[category]
        if (!labelKey) return category
        // Fall back to the raw category name when the locale entry is absent,
        // so the notice never renders an untranslated i18n key.
        const label = t(labelKey)
        return label === labelKey && labelKey !== i18n.t(labelKey) ? category : label
      })
    : []

  return createPortal(
    <div
      ref={overlayRef}
      data-testid="task-feedback-dialog-overlay"
      aria-hidden={capturingScreenshot || undefined}
      className={cn(
        'fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4',
        capturingScreenshot && 'invisible'
      )}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-feedback-dialog-title"
        className="flex max-h-[85vh] w-full max-w-[480px] flex-col rounded-xl border border-border bg-popover p-5 text-text-primary shadow-xl"
      >
        <div className="flex shrink-0 items-start justify-between gap-4">
          <div>
            <h2 id="task-feedback-dialog-title" className="heading-sm">
              {t('workbench.feedback_title')}
            </h2>
            <p className="mt-1 text-sm text-text-secondary">
              {phase === 'preview'
                ? t('workbench.feedback_preview_description')
                : t('workbench.feedback_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="task-feedback-close-button"
            onClick={handleClose}
            disabled={exporting}
            className="flex h-8 min-w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.close_dialog')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {phase === 'done' && result ? (
          <div className="mt-6 shrink-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Check className="h-4 w-4 text-success" />
              {t('workbench.feedback_exported')}
            </div>
            <p className="mt-2 break-all text-xs text-text-secondary">{result.path}</p>
            <p className="mt-1 text-xs text-text-secondary">
              {t('workbench.feedback_report_id')}: {result.reportId}
            </p>
          </div>
        ) : phase === 'preview' && preview ? (
          <FeedbackPreviewList
            preview={preview}
            groupedPreview={groupedPreview}
            skippedLabels={skippedLabels}
            expandedCategory={expandedCategory}
            expandedEntry={expandedEntry}
            onToggleCategory={key => {
              setExpandedCategory(expandedCategory === key ? null : key)
              setExpandedEntry(null)
            }}
            onToggleEntry={path => setExpandedEntry(expandedEntry === path ? null : path)}
          />
        ) : (
          <>
            <div className="mt-5 min-h-0 flex-1 space-y-3 overflow-y-auto">
              {optionGroups.map(group => {
                const disabled = group.sensitive && !hasActiveTask
                const target = group.sensitive ? fullTaskSelection : standardSelection
                const empty = {
                  ...noSelection,
                  ...(group.sensitive ? standardSelection : {}),
                }
                const checked = !disabled && group.options.every(option => selection[option.key])
                const GroupIcon = group.icon
                return (
                  <div
                    key={group.label}
                    className={cn(
                      'rounded-lg border p-3',
                      group.sensitive ? 'border-red-500/40' : 'border-border/60'
                    )}
                  >
                    <label
                      aria-disabled={disabled || undefined}
                      className={cn(
                        'flex items-center gap-3',
                        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
                      )}
                    >
                      <input
                        data-testid={`task-feedback-group-${group.sensitive ? 'full-task' : 'standard'}-checkbox`}
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={event =>
                          setSelection(event.target.checked ? { ...target } : { ...empty })
                        }
                        className="h-4 w-4 shrink-0 accent-current"
                      />
                      <GroupIcon
                        className={cn(
                          'h-4 w-4 shrink-0',
                          group.sensitive ? 'text-red-500' : 'text-text-secondary'
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{group.label}</span>
                        <span
                          className={cn(
                            'block text-xs',
                            group.sensitive ? 'text-red-500/80' : 'text-text-secondary'
                          )}
                        >
                          {disabled ? t('workbench.feedback_requires_task') : group.description}
                        </span>
                      </span>
                    </label>
                    <p className="mt-2 pl-7 text-xs text-text-secondary">
                      {group.options.map(option => option.label).join(' · ')}
                    </p>
                  </div>
                )
              })}
            </div>
            <label className="mt-4 block shrink-0 text-sm font-medium">
              {t('workbench.feedback_note')}
              <textarea
                data-testid="task-feedback-note"
                value={note}
                onChange={event => setNote(event.target.value)}
                placeholder={t('workbench.feedback_note_placeholder')}
                rows={3}
                className="mt-2 w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
              />
            </label>
          </>
        )}

        {error ? <p className="mt-3 text-xs text-red-500">{error}</p> : null}
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          {phase === 'preview' ? (
            <button
              type="button"
              data-testid="task-feedback-back-button"
              onClick={() => void backToConfigure()}
              disabled={exporting}
              className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted"
            >
              {t('workbench.feedback_back')}
            </button>
          ) : (
            <button
              type="button"
              data-testid="task-feedback-cancel-button"
              onClick={handleClose}
              disabled={exporting}
              className="h-9 rounded-md px-3 text-sm font-medium hover:bg-muted"
            >
              {phase === 'done' ? t('workbench.feedback_close') : t('workbench.cancel')}
            </button>
          )}
          {phase === 'configure' ? (
            <button
              type="button"
              data-testid="task-feedback-export-button"
              disabled={!hasSelection || exporting}
              onClick={() => void buildPreview()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileArchive className="h-4 w-4" />
              )}
              {t('workbench.feedback_preview')}
            </button>
          ) : phase === 'preview' ? (
            <button
              type="button"
              data-testid="task-feedback-confirm-button"
              disabled={exporting}
              onClick={() => void confirmExport()}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:opacity-50"
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileArchive className="h-4 w-4" />
              )}
              {t('workbench.feedback_confirm_export')}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  )
}

function waitForScreenshotPaint(): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, 500))
}

type PreviewGroup = {
  key: FeedbackCategory
  label: string
  description: string
  sensitive: boolean
  icon: typeof FileText
  entries: FeedbackEntryPreview[]
}

interface FeedbackPreviewListProps {
  preview: FeedbackPreviewResult
  groupedPreview: PreviewGroup[]
  skippedLabels: string[]
  expandedCategory: FeedbackCategory | null
  expandedEntry: string | null
  onToggleCategory: (key: FeedbackCategory) => void
  onToggleEntry: (path: string) => void
}

function FeedbackPreviewList({
  preview,
  groupedPreview,
  skippedLabels,
  expandedCategory,
  expandedEntry,
  onToggleCategory,
  onToggleEntry,
}: FeedbackPreviewListProps) {
  const { t } = useTranslation('common')
  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  const sections = [
    {
      key: 'standard',
      sensitive: false,
      label: t('workbench.feedback_group_standard'),
      groups: groupedPreview.filter(group => !group.sensitive),
    },
    {
      key: 'full',
      sensitive: true,
      label: t('workbench.feedback_group_full_task'),
      groups: groupedPreview.filter(group => group.sensitive),
    },
  ].filter(section => section.groups.length > 0)

  return (
    <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
      {skippedLabels.length > 0 ? (
        <div
          data-testid="task-feedback-skipped-notice"
          className="mb-3 rounded-lg bg-muted px-3 py-2"
        >
          <p className="text-xs text-text-secondary">
            {t('workbench.feedback_skipped_missing', {
              items: skippedLabels.join('、'),
            })}
          </p>
        </div>
      ) : null}
      {preview.warnings.length > 0 ? (
        <div className="mb-3 rounded-lg bg-muted px-3 py-2">
          {preview.warnings.map(warning => (
            <p key={warning} className="text-xs text-text-secondary">
              {warning}
            </p>
          ))}
        </div>
      ) : null}
      <div className="space-y-3" data-testid="task-feedback-preview-list">
        {sections.map(section => (
          <section key={section.key}>
            <p
              className={cn(
                'mb-1 flex items-center gap-1.5 px-1 text-xs font-medium',
                section.sensitive ? 'text-red-500' : 'text-text-secondary'
              )}
            >
              {section.sensitive ? <ShieldAlert className="h-3.5 w-3.5" /> : null}
              {section.label}
            </p>
            <ul className="space-y-1">
              {section.groups.map(group => (
                <PreviewGroupItem
                  key={group.key}
                  group={group}
                  expanded={expandedCategory === group.key}
                  expandedEntry={expandedEntry}
                  formatSize={formatSize}
                  truncatedLabel={t('workbench.feedback_preview_truncated')}
                  onToggle={() => onToggleCategory(group.key)}
                  onToggleEntry={onToggleEntry}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}

interface PreviewGroupItemProps {
  group: PreviewGroup
  expanded: boolean
  expandedEntry: string | null
  formatSize: (bytes: number) => string
  truncatedLabel: string
  onToggle: () => void
  onToggleEntry: (path: string) => void
}

function PreviewGroupItem({
  group,
  expanded,
  expandedEntry,
  formatSize,
  truncatedLabel,
  onToggle,
  onToggleEntry,
}: PreviewGroupItemProps) {
  const Icon = group.icon
  const totalBytes = group.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
  return (
    <li
      className={cn(
        'rounded-lg border',
        group.sensitive ? 'border-red-500/40' : 'border-border/60'
      )}
    >
      <button
        type="button"
        data-testid={`task-feedback-preview-category-${group.key}`}
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-muted"
      >
        <Icon
          className={cn(
            'h-4 w-4 shrink-0',
            group.sensitive ? 'text-red-500' : 'text-text-secondary'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{group.label}</span>
          <span
            className={cn(
              'block truncate text-xs',
              group.sensitive ? 'text-red-500/80' : 'text-text-secondary'
            )}
          >
            {group.description}
          </span>
        </span>
        <span className="shrink-0 text-xs text-text-secondary">{formatSize(totalBytes)}</span>
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-text-secondary" />
        )}
      </button>
      {expanded ? (
        <ul className={cn('border-t', group.sensitive ? 'border-red-500/40' : 'border-border/60')}>
          {group.entries.map(entry => {
            const entryExpanded = expandedEntry === entry.archivePath
            return (
              <li key={entry.archivePath}>
                <button
                  type="button"
                  data-testid={`task-feedback-preview-entry-${entry.archivePath}`}
                  disabled={!entry.previewable}
                  onClick={() => onToggleEntry(entry.archivePath)}
                  className={cn(
                    'flex w-full items-center gap-2 py-1.5 pl-10 pr-3 text-left',
                    entry.previewable ? 'hover:bg-muted' : 'cursor-default'
                  )}
                >
                  {entry.previewable ? (
                    entryExpanded ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-text-secondary" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary" />
                    )
                  ) : (
                    <span className="w-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs">{entry.archivePath}</span>
                  <span className="shrink-0 text-xs text-text-secondary">
                    {formatSize(entry.sizeBytes)}
                  </span>
                </button>
                {entryExpanded && entry.content != null ? (
                  <pre
                    data-testid="task-feedback-preview-content"
                    className="max-h-64 overflow-auto border-t border-border/60 bg-background px-3 py-2 text-xs text-text-secondary"
                  >
                    {entry.content}
                    {entry.truncated ? `\n… ${truncatedLabel}` : ''}
                  </pre>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}
