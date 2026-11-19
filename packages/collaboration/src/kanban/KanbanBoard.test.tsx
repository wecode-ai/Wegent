// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectBoardTransfer } from '../project-board/ProjectBoardTransfer'
import { useProjectBoardCardTransfer } from '../project-board/projectBoardTransferContext'
import {
  KanbanColumn,
  KanbanColumnDropzone,
  type KanbanBoardProps,
} from './KanbanBoard'

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function node(id: string) {
  const result = container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!result) throw new Error(`Missing ${id}`)
  return result
}
const metadata = {
  itemId: 'Issue',
  columnKey: 'pending',
  groupBy: 'status' as const,
}
function Source() {
  const { setElement, buttonProps } = useProjectBoardCardTransfer(
    'source',
    metadata,
    true,
  )
  return (
    <button ref={setElement} {...buttonProps} data-testid="source">
      Issue
    </button>
  )
}

describe('KanbanColumnDropzone', () => {
  it('constrains long cards so they cannot widen the column', () => {
    act(() =>
      root.render(
        <ProjectBoardTransfer>
          <KanbanColumnDropzone
            dropId="todo-column:pending"
            testId="cloud-todo-column-dropzone-pending"
          >
            <article>{'LongTaskTitleWithoutWordBreaks'.repeat(20)}</article>
          </KanbanColumnDropzone>
        </ProjectBoardTransfer>,
      ),
    )
    expect(
      node('cloud-todo-column-dropzone-pending-viewport').className,
    ).toContain('overflow-y-auto')
    expect(
      node('cloud-todo-column-dropzone-pending-viewport').className,
    ).toContain('pr-1.5')
    expect(
      node('cloud-todo-column-dropzone-pending-content').className,
    ).toContain('w-full')
  })
  it('preserves classes, test id and active drag hint with a real SDK draft', async () => {
    await act(async () =>
      root.render(
        <ProjectBoardTransfer>
          <KanbanColumnDropzone
            dragHint="移到这里：等待开始"
            dropId="todo-column:pending"
            testId="cloud-todo-column-dropzone-pending"
          >
            <Source />
          </KanbanColumnDropzone>
        </ProjectBoardTransfer>,
      ),
    )
    await act(async () =>
      node('source').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(node('cloud-todo-column-dropzone-pending').className).toContain(
      'relative flex min-h-0 flex-1 flex-col transition-colors',
    )
    expect(node('cloud-todo-column-dropzone-pending').className).toContain(
      'rounded-xl bg-muted ring-1 ring-inset ring-focus/50',
    )
    expect(node('cloud-todo-column-drag-hint-pending').textContent).toBe(
      '移到这里：等待开始',
    )
    expect(node('cloud-todo-column-dropzone-pending-viewport')).toBeDefined()
    expect(node('cloud-todo-column-dropzone-pending-content')).toBeDefined()
  })
})

describe('KanbanColumn', () => {
  it('renders the original column shell and actionable empty state through generic data', async () => {
    const onCreate = vi.fn()
    const column = { key: 'inbox', label: '收集箱', dotClass: 'bg-zinc-400' }
    const props: KanbanBoardProps<typeof column, { id: string }> = {
      activeDragItemId: 'ISSUE-1',
      columns: [column],
      dropIdPrefix: 'todo-column:',
      getColumnDotClassName: (value) => value.dotClass,
      getColumnDragHint: () => undefined,
      getColumnEmptyState: () => ({
        action: {
          ariaLabel: '在收集箱中新建 Issue',
          label: '创建第一个 Issue',
          onClick: onCreate,
        },
        hint: '先记录一个需要推进的问题、目标或交付。',
      }),
      getColumnItems: () => [],
      getColumnKey: (value) => value.key,
      getColumnLabel: (value) => value.label,
      getColumnWidthClassName: () => 'w-[292px]',
      getItemKey: (item) => item.id,
      renderAddIcon: () => <svg />,
      renderItem: () => null,
      testIdPrefix: 'cloud-todo',
    }
    act(() =>
      root.render(
        <ProjectBoardTransfer>
          <KanbanColumn {...props} column={column} />
        </ProjectBoardTransfer>,
      ),
    )
    const shell = node('cloud-todo-column-inbox')
    expect(shell.className).toContain(
      'group flex max-h-full shrink-0 flex-col rounded-2xl bg-muted p-0.5 transition-[width]',
    )
    expect(shell.className).toContain('w-[292px]')
    expect(shell.className).toContain(
      'outline-dashed outline-1 -outline-offset-1 outline-border',
    )
    expect(shell.firstElementChild?.tagName).toBe('HEADER')
    expect(node('cloud-todo-column-dropzone-inbox')).toBeDefined()
    const empty = node('cloud-todo-column-empty-add-inbox')
    expect(empty.getAttribute('aria-label')).toBe('在收集箱中新建 Issue')
    expect(empty.className).toContain(
      'flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed',
    )
    await act(async () => empty.click())
    expect(onCreate).toHaveBeenCalledOnce()
  })
})
