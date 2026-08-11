import {
  ArrowLeft,
  Check,
  ClipboardList,
  Eye,
  LayoutDashboard,
  Paperclip,
  Plus,
  Target,
} from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CloudProject } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { Tooltip } from '@/components/ui/tooltip'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'
import { useAnchoredPortalMenu } from './useAnchoredPortalMenu'
import { useOutsideClick } from './useOutsideClick'

interface AddContextMenuProps {
  disabled: boolean
  onFileSelect: (files: File | File[]) => void
  onSetPlanMode?: () => void
  onSetGoal?: () => void
  onConfigureSupervisor?: () => void
  supervisorEnabled?: boolean
  supervisorPending?: boolean
  cloudProjectCandidates?: ComposerCloudMentionCandidate[]
  selectedCloudProjectId?: CloudProject['id']
  onSelectCloudProject?: (project: CloudProject) => void
}

export function AddContextMenu({
  disabled,
  onFileSelect,
  onSetPlanMode,
  onSetGoal,
  onConfigureSupervisor,
  supervisorEnabled = false,
  supervisorPending = false,
  cloudProjectCandidates = [],
  selectedCloudProjectId,
  onSelectCloudProject,
}: AddContextMenuProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'root' | 'project-spaces'>('root')
  const closeMenu = useCallback(() => {
    setOpen(false)
    setView('root')
  }, [])
  const outsideRefs = useMemo(() => [menuRef], [])
  const menuLayout = useAnchoredPortalMenu(open, triggerRef, menuRef)

  useOutsideClick(containerRef, open, closeMenu, outsideRefs)

  useEffect(() => {
    if (!open) return undefined

    const trigger = triggerRef.current
    const animationFrame = window.requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      closeMenu()
    }
    window.addEventListener('keydown', handleKeyDown, true)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('keydown', handleKeyDown, true)
      trigger?.focus()
    }
  }, [closeMenu, open])

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
      event.target.value = ''
      setOpen(false)
    },
    [onFileSelect]
  )

  const handleSetGoal = useCallback(() => {
    setOpen(false)
    onSetGoal?.()
  }, [onSetGoal])

  const handleSetPlanMode = useCallback(() => {
    setOpen(false)
    onSetPlanMode?.()
  }, [onSetPlanMode])

  const handleConfigureSupervisor = useCallback(() => {
    setOpen(false)
    onConfigureSupervisor?.()
  }, [onConfigureSupervisor])

  const selectableProjectSpaces = cloudProjectCandidates.filter(
    (candidate): candidate is ComposerCloudMentionCandidate & { project: CloudProject } =>
      candidate.enabled && Boolean(candidate.project)
  )

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="attachment-file-input"
        onChange={handleFileChange}
      />
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            data-testid="add-context-menu"
            style={{
              left: menuLayout?.left ?? 0,
              maxHeight: menuLayout?.maxHeight,
              top: menuLayout?.top ?? 0,
              visibility: menuLayout ? 'visible' : 'hidden',
            }}
            className="fixed z-system-popover w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
          >
            {view === 'project-spaces' ? (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="project-space-menu-back"
                  onClick={() => setView('root')}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-medium text-text-primary hover:bg-muted"
                >
                  <ArrowLeft className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                  <span>{t('workbench.add_context_project_space', '项目空间')}</span>
                </button>
                <div className="my-1 h-px bg-border" />
                {selectableProjectSpaces.map(candidate => {
                  const selected = candidate.project.id === selectedCloudProjectId
                  return (
                    <button
                      key={candidate.key}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      data-testid={`add-context-${candidate.testId}`}
                      onClick={() => {
                        onSelectCloudProject?.(candidate.project)
                        closeMenu()
                      }}
                      className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-text-primary hover:bg-muted"
                    >
                      <LayoutDashboard className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{candidate.title}</span>
                        {(candidate.description || candidate.statusLabel) && (
                          <span className="block truncate text-xs text-text-muted">
                            {[candidate.statusLabel, candidate.description]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}
                      </span>
                      {selected && <Check className="h-4 w-4 shrink-0" />}
                    </button>
                  )
                })}
              </>
            ) : (
              <>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="attach-files-button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
                >
                  <Paperclip className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                  <span>{t('workbench.add_photos_files', '添加照片和文件')}</span>
                </button>
                {selectableProjectSpaces.length > 0 && onSelectCloudProject && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="add-project-space-context-button"
                    onClick={() => setView('project-spaces')}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <LayoutDashboard className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1 truncate">
                      {t('workbench.add_context_project_space', '项目空间')}
                    </span>
                    <span className="max-w-40 truncate text-sm text-text-muted">
                      {selectableProjectSpaces.find(
                        candidate => candidate.project.id === selectedCloudProjectId
                      )?.title ?? t('workbench.add_context_project_space_select', '选择看板')}
                    </span>
                  </button>
                )}
                {onSetPlanMode && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="set-plan-mode-button"
                    onClick={handleSetPlanMode}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <ClipboardList className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                    <span className="min-w-0 truncate">
                      <span>{t('workbench.plan_mode', '计划模式')}</span>
                      <span className="ml-2 text-text-muted">
                        {t('workbench.enable_plan_mode', '开启计划模式')}
                      </span>
                    </span>
                  </button>
                )}
                {onSetGoal && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="set-goal-button"
                    onClick={handleSetGoal}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <Target className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                    <span className="min-w-0 truncate">
                      <span>{t('workbench.goal_chip', '目标')}</span>
                      <span className="ml-2 text-text-muted">
                        {t('workbench.pursue_goal_description', '设置 WeWork 将持续努力实现的目标')}
                      </span>
                    </span>
                  </button>
                )}
                {onConfigureSupervisor && (
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="task-supervisor-toggle-button"
                    onClick={handleConfigureSupervisor}
                    className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
                  >
                    <Eye className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
                    <span className="min-w-0 truncate">
                      <span>{t('workbench.supervisor_title')}</span>
                      <span className="ml-2 text-text-muted">
                        {supervisorPending
                          ? t('workbench.supervisor_pending_menu')
                          : supervisorEnabled
                            ? t('workbench.supervisor_configure')
                            : t('workbench.supervisor_enable')}
                      </span>
                    </span>
                  </button>
                )}
              </>
            )}
          </div>,
          document.body
        )}
      <Tooltip
        label={t('workbench.add_context', '添加上下文')}
        align="start"
        testId="composer-add-context-tooltip"
      >
        <button
          ref={triggerRef}
          type="button"
          data-testid="add-context-button"
          onClick={() => !disabled && setOpen(current => !current)}
          disabled={disabled}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-text-primary hover:bg-background/70 disabled:cursor-not-allowed disabled:opacity-50"
          aria-expanded={open}
          aria-label={t('workbench.add_context', '添加上下文')}
        >
          <Plus className="h-5 w-5" strokeWidth={1.5} />
        </button>
      </Tooltip>
    </div>
  )
}
