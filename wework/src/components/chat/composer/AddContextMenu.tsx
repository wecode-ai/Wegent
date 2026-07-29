import { ClipboardList, Paperclip, Plus, Target } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from '@/hooks/useTranslation'
import { useAnchoredPortalMenu } from './useAnchoredPortalMenu'
import { useOutsideClick } from './useOutsideClick'

interface AddContextMenuProps {
  disabled: boolean
  onFileSelect: (files: File | File[]) => void
  onSetPlanMode?: () => void
  onSetGoal?: () => void
}

export function AddContextMenu({
  disabled,
  onFileSelect,
  onSetPlanMode,
  onSetGoal,
}: AddContextMenuProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])
  const outsideRefs = useMemo(() => [menuRef], [])
  const menuLayout = useAnchoredPortalMenu(open, triggerRef, menuRef)

  useOutsideClick(containerRef, open, closeMenu, outsideRefs)

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
            data-testid="add-context-menu"
            style={{
              left: menuLayout?.left ?? 0,
              maxHeight: menuLayout?.maxHeight,
              top: menuLayout?.top ?? 0,
              visibility: menuLayout ? 'visible' : 'hidden',
            }}
            className="fixed z-system-popover w-[22rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
          >
            <button
              type="button"
              data-testid="attach-files-button"
              onClick={() => fileInputRef.current?.click()}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-base font-normal leading-[18px] text-text-primary hover:bg-muted"
            >
              <Paperclip className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
              <span>{t('workbench.add_photos_files', '添加照片和文件')}</span>
            </button>
            {onSetPlanMode && (
              <button
                type="button"
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
          </div>,
          document.body
        )}
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
    </div>
  )
}
