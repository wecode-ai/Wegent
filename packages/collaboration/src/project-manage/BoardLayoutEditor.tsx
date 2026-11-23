import { SortableRoot, SortableItem, SortableHandle } from '../controls/Sortable'
import { Menu, MenuContent, MenuTrigger, MenuCheckboxItem } from '../controls/MenuParts'
import { controlTrigger, controlPopup, controlOption } from '../controls/recipes'
import { isImeComposingEvent } from '@wegent/chat-core/ime'
import { Check, ChevronDown, Clock3, GripVertical, Pencil, Plus, Tag, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { TextField as ControlInput } from '../controls/TextField'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { useCollaborationPortalTheme } from '../theme'
import type { ProjectManageCardDisplay, ProjectManageHost, ProjectManageStatus } from './types'

type BoardStatus = ProjectManageStatus
type BoardCardDisplaySettings = ProjectManageCardDisplay

function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

const statusDotClasses: Record<BoardStatus['color'], string> = {
  gray: 'bg-zinc-400',
  blue: 'bg-blue-500',
  orange: 'bg-amber-500',
  purple: 'bg-violet-500',
  green: 'bg-emerald-500',
  red: 'bg-red-500',
}

const newStatusColors: BoardStatus['color'][] = ['gray', 'blue', 'orange', 'purple', 'green', 'red']

interface SortableStatusProps {
  status: BoardStatus
  previewDisplay?: BoardCardDisplaySettings
  busy: boolean
  renaming: boolean
  onRename: () => void
  onRenameCommit: (name: string) => void
  onDelete: () => void
  renderActionMenu?: ProjectManageHost['renderActionMenu']
  translate: CollaborationTranslate
}

function SortableStatus({
  status,
  previewDisplay,
  busy,
  renaming,
  onRename,
  onRenameCommit,
  onDelete,
  renderActionMenu,
  translate,
}: SortableStatusProps) {
  return (
    <SortableItem
      render={<article />}
      value={status.id}
      label={status.name}
      disabled={busy || renaming}
      data-testid={`cloud-board-status-${status.id}`}
      className={cn(
        'group/status min-h-36 min-w-32 rounded-xl border p-2 transition-colors',
        'border-transparent hover:bg-background/70'
      )}
    >
      <header className="flex min-h-11 min-w-0 items-center gap-1 md:min-h-7">
        <SortableHandle
          type="button"
          data-testid={`cloud-board-status-drag-${status.id}`}
          disabled={busy || renaming}
          className="flex h-6 w-5 shrink-0 touch-none items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-default"
          aria-label={translate('todo.drag_status', '拖动状态 {{name}}', {
            name: status.name,
          })}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </SortableHandle>
        <span className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClasses[status.color])} />
        {renaming ? (
          <ControlInput
            data-testid={`cloud-board-status-name-${status.id}`}
            density="dense"
            autoFocus
            defaultValue={status.name}
            onBlur={event => onRenameCommit(event.currentTarget.value)}
            onKeyDown={event => {
              if (isImeComposingEvent(event)) return
              if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') event.currentTarget.value = status.name
                event.currentTarget.blur()
              }
            }}
            className="min-w-0 flex-1"
            aria-label={translate('todo.status_name', '状态名称')}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{status.name}</span>
        )}
        {!renaming &&
          renderActionMenu?.({
            ariaLabel: translate('todo.status_menu', '{{name}}状态菜单', {
              name: status.name,
            }),
            testId: `cloud-board-status-menu-${status.id}`,
            placement: 'bottom-end',
            density: 'dense',
            triggerClassName:
              'flex items-center justify-center rounded-md text-text-muted opacity-0 hover:bg-muted hover:text-text-primary focus-visible:opacity-100 group-hover/status:opacity-100',
            items: [
              {
                label: translate('todo.rename', '重命名'),
                icon: Pencil,
                onSelect: onRename,
                testId: `cloud-board-status-rename-${status.id}`,
                disabled: busy,
              },
              {
                label: translate('todo.delete_status', '删除状态'),
                icon: Trash2,
                onSelect: onDelete,
                testId: `cloud-board-status-delete-${status.id}`,
                danger: true,
                disabled: busy,
              },
            ],
          })}
      </header>
      {previewDisplay ? (
        <PreviewCard display={previewDisplay} translate={translate} />
      ) : (
        <>
          <div className="mt-3 h-1.5 rounded-full bg-border/70" />
          <div className="mt-2 h-1.5 w-3/5 rounded-full bg-border/70" />
        </>
      )}
    </SortableItem>
  )
}

function PreviewCard({
  display,
  translate,
}: {
  display: BoardCardDisplaySettings
  translate: CollaborationTranslate
}) {
  return (
    <div className="mt-2.5 rounded-lg border border-border bg-background p-2.5 shadow-sm">
      <p className="text-xs font-medium leading-4">
        {translate('todo.board_preview_title', '补充项目管理页的空状态')}
      </p>
      {display.showTags && (
        <span className="mt-2 inline-flex h-5 items-center gap-1 rounded-md bg-muted px-1.5 text-xs text-text-secondary">
          <Tag className="h-3 w-3" />
          {translate('todo.board_preview_tag', '产品需求')}
        </span>
      )}
      <div className="mt-2 flex min-h-5 items-center gap-1.5 text-xs text-text-muted">
        {display.showPriority && (
          <span>{translate('todo.board_preview_priority', '中优先级')}</span>
        )}
        {display.showDate && (
          <span className="flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            {translate('todo.board_preview_date', '刚刚')}
          </span>
        )}
        {display.showAssignee && (
          <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-text-primary text-xs text-background">
            {translate('todo.board_preview_assignee', '林')}
          </span>
        )}
      </div>
    </div>
  )
}

export function BoardLayoutEditor({
  statuses,
  display,
  statusBusy,
  displayBusy,
  canEditStatuses,
  embedded = false,
  previewColumns,
  portalContainer,
  onStatusesChange,
  onDisplayChange,
  renderActionMenu,
  translate = (key, fallback) => fallback ?? key,
}: {
  statuses: BoardStatus[]
  display: BoardCardDisplaySettings
  statusBusy: boolean
  displayBusy: boolean
  canEditStatuses: boolean
  embedded?: boolean
  previewColumns?: readonly BoardStatus[]
  portalContainer?: HTMLElement | null
  onStatusesChange: (statuses: BoardStatus[]) => void
  onDisplayChange: (key: keyof BoardCardDisplaySettings, checked: boolean) => void
  renderActionMenu?: ProjectManageHost['renderActionMenu']
  translate?: CollaborationTranslate
}) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const portalTheme = useCollaborationPortalTheme()

  function addStatus() {
    const id = `status-${Date.now().toString(36)}`
    onStatusesChange([
      ...statuses,
      {
        id,
        name: translate('todo.new_status', '新状态'),
        color: newStatusColors[statuses.length % newStatusColors.length],
      },
    ])
  }

  const displayOptions = [
    ['showAssignee', translate('todo.assignee', '负责人')],
    ['showPriority', translate('todo.priority', '优先级')],
    ['showTags', translate('todo.tags', '标签')],
    ['showDate', translate('todo.updated_at', '更新时间')],
  ] as const

  return (
    <section
      data-testid="cloud-project-board-layout-settings"
      className={embedded ? '' : 'border-t border-border py-6'}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className={embedded ? 'text-lg font-medium' : 'text-heading-md font-semibold'}>
            {translate('todo.board_layout', '看板布局')}
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            {canEditStatuses && !previewColumns
              ? translate(
                  'todo.board_layout_edit_description',
                  '拖动状态调整顺序，选择任务卡上需要显示的信息。'
                )
              : translate('todo.board_layout_display_description', '选择任务卡上需要显示的信息。')}
          </p>
        </div>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                data-testid="cloud-board-display-menu"
                disabled={displayBusy}
                className={controlTrigger}
              />
            }
          >
            {translate('todo.display_fields', '显示字段')}
            <ChevronDown className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          </MenuTrigger>
          <>
            <MenuContent
              container={portalContainer}
              {...portalTheme}
              align="end"
              sideOffset={4}
              collisionPadding={8}
              data-testid="cloud-project-card-display-settings"
              data-embedded-browser-occlusion
              aria-label={translate('todo.card_display', '任务卡显示')}
              className={cn(portalTheme.className, controlPopup, 'w-44')}
            >
              <p className="px-2 py-1 text-xs text-text-muted">
                {translate('todo.card_display', '任务卡显示')}
              </p>
              {displayOptions.map(([key, label]) => (
                <MenuCheckboxItem
                  key={key}
                  value={key}
                  render={<button type="button" />}
                  checked={display[key]}
                  data-testid={`cloud-board-display-${key.replace('show', '').toLowerCase()}`}
                  disabled={displayBusy}
                  onCheckedChange={checked => onDisplayChange(key, checked)}
                  className={controlOption}
                >
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded border',
                      display[key]
                        ? 'border-text-primary bg-text-primary text-background'
                        : 'border-border'
                    )}
                  >
                    {display[key] && <Check className="h-3 w-3" />}
                  </span>
                  {label}
                </MenuCheckboxItem>
              ))}
            </MenuContent>
          </>
        </Menu>
      </div>

      <div className="mt-4 overflow-x-auto rounded-2xl bg-muted p-2.5">
        {previewColumns ? (
          <div className="flex min-w-max items-start gap-2" data-testid="board-view-preview">
            {previewColumns.map((column, index) => (
              <article
                key={column.id}
                data-testid={`board-view-preview-${column.id}`}
                className="min-h-36 w-40 shrink-0 p-2"
              >
                <header className="flex h-7 items-center gap-2">
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', statusDotClasses[column.color])}
                  />
                  <span className="truncate text-xs font-medium">{column.name}</span>
                </header>
                {index === Math.min(1, previewColumns.length - 1) ? (
                  <PreviewCard display={display} translate={translate} />
                ) : (
                  <>
                    <div className="mt-3 h-1.5 rounded-full bg-border/70" />
                    <div className="mt-2 h-1.5 w-3/5 rounded-full bg-border/70" />
                  </>
                )}
              </article>
            ))}
          </div>
        ) : (
          <SortableRoot
            value={statuses.map(status => status.id)}
            orientation="horizontal"
            aria-label={translate('todo.board_layout', '看板布局')}
            onValueChange={(ids, details) => {
              if (statusBusy || !canEditStatuses) {
                details.cancel()
                return
              }
              const next = ids
                .map(id => statuses.find(status => status.id === id))
                .filter((status): status is BoardStatus => Boolean(status))
              if (next.length === statuses.length) onStatusesChange(next)
              else details.cancel()
            }}
          >
            {state => (
              <div className="flex min-w-max items-start gap-2">
                {(state.moving?.order ?? state.value)
                  .map(id => statuses.find(status => status.id === id))
                  .filter((status): status is BoardStatus => Boolean(status))
                  .map((status, index) => (
                    <div key={status.id} className="w-36 shrink-0">
                      <SortableStatus
                        status={status}
                        previewDisplay={
                          index === Math.min(1, statuses.length - 1) ? display : undefined
                        }
                        busy={statusBusy || !canEditStatuses}
                        renaming={renamingId === status.id}
                        onRename={() => setRenamingId(status.id)}
                        onRenameCommit={name => {
                          setRenamingId(null)
                          const normalized = name.trim()
                          if (!normalized || normalized === status.name) return
                          onStatusesChange(
                            statuses.map(item =>
                              item.id === status.id ? { ...item, name: normalized } : item
                            )
                          )
                        }}
                        onDelete={() =>
                          onStatusesChange(statuses.filter(item => item.id !== status.id))
                        }
                        renderActionMenu={renderActionMenu}
                        translate={translate}
                      />
                    </div>
                  ))}
                {statuses.length === 0 && (
                  <div className="w-56 shrink-0 rounded-xl bg-background/70 p-2">
                    <p className="px-0.5 text-xs font-medium">
                      {translate('todo.card_preview', '任务卡预览')}
                    </p>
                    <PreviewCard display={display} translate={translate} />
                  </div>
                )}
                {canEditStatuses && (
                  <ControlButton
                    variant="outline"
                    size="sm"
                    type="button"
                    data-testid="cloud-board-status-add"
                    disabled={statusBusy}
                    onClick={addStatus}
                    className="mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-dashed border-border text-text-muted hover:bg-background hover:text-text-primary disabled:opacity-50"
                    aria-label={translate('todo.add_status', '新增状态')}
                  >
                    <Plus className="h-4 w-4" />
                  </ControlButton>
                )}
              </div>
            )}
          </SortableRoot>
        )}
      </div>
      <p className="mt-2 text-xs text-text-muted">
        {previewColumns
          ? translate('todo.board_view_card_scope')
          : translate('todo.board_settings_sync', '设置会同步给所有项目成员。')}
      </p>
    </section>
  )
}
