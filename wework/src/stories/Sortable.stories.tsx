import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { GripVertical } from 'lucide-react'
import {
  SortableRoot,
  SortableItem,
  SortableHandle,
  SortableDragArea,
} from '@wegent/collaboration/controls/Sortable'
import { TextField } from '@wegent/collaboration/controls/TextField'
import { BoardLayoutEditor } from '../../../packages/collaboration/src/project-manage/BoardLayoutEditor'
import type { ProjectManageStatus } from '../../../packages/collaboration/src/project-manage/types'
import { useTranslation } from '@/hooks/useTranslation'
import { createCollaborationTranslator } from '@wegent/collaboration'
const meta = {
  title: 'Controls/Sortable',
  component: SortableRoot,
  parameters: {
    docs: {
      description: {
        component:
          'List with separate drag handles. Space/Enter picks up or drops; arrows, Home/End move; Escape/Tab cancels. Input controls preserve their own interaction. / 列表与独立拖拽手柄：空格/回车拾取放下，方向键移动，Escape/Tab 取消，嵌套输入保留原交互。',
      },
    },
  },
} satisfies Meta<typeof SortableRoot>
export default meta
type Story = StoryObj<Record<string, never>>
function Example({ disabled = false, pointerArea = false }) {
  const { t } = useTranslation('componentCatalog')
  const [saved, setSaved] = useState(['one', 'two', 'three'])
  return (
    <div className="max-w-lg space-y-4">
      <SortableRoot
        aria-label={t('status')}
        defaultValue={saved}
        onValueChange={setSaved}
        canStartPointer={event =>
          !(
            event.target instanceof Element &&
            event.target.closest('input,button,a,textarea,[contenteditable]')
          )
        }
        data-testid="catalog-sortable"
      >
        {state =>
          (state.moving?.order ?? state.value).map(id => (
            <SortableItem
              key={id}
              value={id}
              label={id}
              disabled={disabled}
              className="flex items-center gap-2 rounded-lg border border-border p-2"
              data-testid={`catalog-sortable-row-${id}`}
            >
              <SortableHandle data-testid={`catalog-sortable-handle-${id}`}>
                <GripVertical aria-hidden="true" />
              </SortableHandle>
              <SortableDragArea
                disabled={!pointerArea}
                className="flex min-w-0 flex-1 items-center gap-2 p-1"
                data-testid={`catalog-sortable-drag-area-${id}`}
              >
                {pointerArea && <span className="cursor-grab select-none">{id}</span>}
                <TextField
                  aria-label={`${t('name')} ${id}`}
                  defaultValue={id}
                  data-testid={`catalog-sortable-input-${id}`}
                  className="min-w-0 flex-1"
                />
              </SortableDragArea>
            </SortableItem>
          ))
        }
      </SortableRoot>
      <output data-testid="catalog-sortable-saved">{saved.join(' / ')}</output>
    </div>
  )
}
function Board() {
  const [display, setDisplay] = useState({
    showAssignee: true,
    showPriority: true,
    showTags: true,
    showDate: true,
  })
  const { i18n } = useTranslation('componentCatalog')
  const [statuses, setStatuses] = useState<ProjectManageStatus[]>([
    { id: 'open', name: 'Open / 待处理', color: 'gray' },
    { id: 'doing', name: 'In progress / 进行中', color: 'blue' },
    { id: 'done', name: 'Done / 已完成', color: 'green' },
  ])
  return (
    <BoardLayoutEditor
      statuses={statuses}
      onStatusesChange={setStatuses}
      display={display}
      onDisplayChange={(key, checked) => setDisplay(current => ({ ...current, [key]: checked }))}
      statusBusy={false}
      displayBusy={false}
      canEditStatuses
      translate={createCollaborationTranslator(i18n.language === 'en' ? 'en' : 'zh-CN')}
    />
  )
}
export const EditableItems: Story = { render: () => <Example /> }
export const Disabled: Story = { render: () => <Example disabled /> }
export const ProductionBoardStates: Story = { render: () => <Board /> }

export const PointerArea: Story = { render: () => <Example pointerArea /> }
