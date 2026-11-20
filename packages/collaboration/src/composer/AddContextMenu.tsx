import { ClipboardList, Eye, Paperclip, PencilLine, Plus, Target } from 'lucide-react'
import { useRef } from 'react'
import { ActionMenu, type ActionMenuItem } from '../controls/ActionMenu'
import type { CollaborationTranslate } from '../i18n'

export interface AddContextMenuProps {
  translate: CollaborationTranslate
  disabled: boolean
  onFileSelect: (files: File | File[]) => void
  showAttachmentActions?: boolean
  onDraw?: () => void
  onSetPlanMode?: () => void
  onSetGoal?: () => void
  onConfigureSupervisor?: () => void
  supervisorEnabled?: boolean
  supervisorPending?: boolean
}

export function AddContextMenu({
  translate: t,
  disabled,
  onFileSelect,
  onDraw,
  showAttachmentActions = true,
  onSetPlanMode,
  onSetGoal,
  onConfigureSupervisor,
  supervisorEnabled = false,
  supervisorPending = false,
}: AddContextMenuProps) {
  const fileInput = useRef<HTMLInputElement>(null)
  const describe = (label: string, description: string, testId?: string) => (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span>{label}</span>
      <span data-testid={testId} className="whitespace-normal text-xs text-text-secondary">
        {description}
      </span>
    </span>
  )
  const items: ActionMenuItem[] = [
    ...(showAttachmentActions
      ? [
          {
            testId: 'attach-files-button',
            label: t('workbench.add_photos_files', '添加照片和文件'),
            icon: Paperclip,
            onSelect: () => fileInput.current?.click(),
          },
        ]
      : []),
    ...(onSetPlanMode
      ? [
          {
            testId: 'set-plan-mode-button',
            label: describe(
              t('workbench.plan_mode', '计划模式'),
              t('workbench.enable_plan_mode', '开启计划模式')
            ),
            icon: ClipboardList,
            onSelect: onSetPlanMode,
          },
        ]
      : []),
    ...(onSetGoal
      ? [
          {
            testId: 'set-goal-button',
            label: describe(
              t('workbench.goal_chip', '目标'),
              t('workbench.pursue_goal_description', '设置 WeWork 将持续努力实现的目标'),
              'goal-mode-description'
            ),
            icon: Target,
            onSelect: onSetGoal,
          },
        ]
      : []),
    ...(onConfigureSupervisor
      ? [
          {
            testId: 'task-supervisor-toggle-button',
            label: describe(
              t('workbench.supervisor_title'),
              t(
                supervisorPending
                  ? 'workbench.supervisor_pending_menu'
                  : supervisorEnabled
                    ? 'workbench.supervisor_configure'
                    : 'workbench.supervisor_enable'
              )
            ),
            icon: Eye,
            onSelect: onConfigureSupervisor,
          },
        ]
      : []),
    ...(onDraw
      ? [
          {
            testId: 'draw-attachment-button',
            label: describe(
              t('workbench.drawing.title', '绘图'),
              t('workbench.drawing.description', '绘制草图')
            ),
            icon: PencilLine,
            onSelect: onDraw,
          },
        ]
      : []),
  ]
  return (
    <div className="relative">
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        data-testid="attachment-file-input"
        onChange={event => {
          const files = event.target.files
          if (files?.length) onFileSelect(Array.from(files))
          event.target.value = ''
        }}
      />
      <ActionMenu
        density="dense"
        testId="add-context-button"
        menuTestId="add-context-menu"
        ariaLabel={t('workbench.add_context', '添加上下文')}
        icon={Plus}
        disabled={disabled}
        items={items}
        placement="top-start"
        width={352}
        triggerClassName="flex shrink-0 items-center justify-center rounded-full text-text-primary hover:bg-muted disabled:opacity-40"
      />
    </div>
  )
}
