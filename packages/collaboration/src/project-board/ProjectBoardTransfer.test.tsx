import { useProjectBoardDropTarget } from './projectBoardTransferContext'
// @vitest-environment jsdom
import { act, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { IssueBoardCard } from '../issue-card/IssueBoardCard'
import { createIssueBoardCardLabels } from '../issue-card/messages'
import { createCollaborationTranslator } from '../i18n'
import { CollaborationTheme } from '../theme'
import { ProjectBoardCardContext } from './projectBoardCardContext'
import { ProjectBoardTransfer } from './ProjectBoardTransfer'
import { projectBoardDragItemId } from './projectBoardDnd'
import {
  useStandardCloudBoardController,
  type StandardCloudBoardItem,
} from './useStandardCloudBoardController'
import type { ProjectBoardColumn } from './ProjectBoardBody'

const columns: ProjectBoardColumn[] = ['pending', 'completed'].map(key => ({
  key,
  groupValue: key,
  label: key,
  status: key,
  dotClass: '',
}))
const item: StandardCloudBoardItem = {
  id: 'moving',
  parent_id: null,
  status: 'pending',
  priority: 'none',
  sort_order: 0,
  tags: ['keep-tag'],
  created_at: '2026-11-01',
  updated_at: '2026-11-01',
}
const save =
  vi.fn<(item: StandardCloudBoardItem, status: string) => Promise<StandardCloudBoardItem>>()
let root: Root
let container: HTMLDivElement

function Card({ item, enabled }: { item: StandardCloudBoardItem; enabled: boolean }) {
  const translate = createCollaborationTranslator('en')
  return (
    <IssueBoardCard
      item={{ ...item, title: item.id, priority: 'none' }}
      reference="TEST-1"
      labels={createIssueBoardCardLabels(translate)}
      translate={translate}
      display={{
        showAssignee: false,
        showDate: false,
        showPriority: false,
        showTags: true,
      }}
      dragEnabled={enabled}
      detailButtonTestId={`card-${item.id}`}
      onOpen={() => {}}
    />
  )
}
function Column({
  column,
  items,
  enabled,
}: {
  column: ProjectBoardColumn
  items: StandardCloudBoardItem[]
  enabled: boolean
}) {
  const { setElement } = useProjectBoardDropTarget({
    id: `todo-column:${column.key}`,
  })
  const value = useMemo(() => ({ columnKey: column.key, groupBy: 'status' as const }), [column.key])
  return (
    <section ref={setElement} data-testid={`column-${column.key}`}>
      <ProjectBoardCardContext.Provider value={value}>
        {items.map(item => (
          <Card key={item.id} item={item} enabled={enabled} />
        ))}
      </ProjectBoardCardContext.Provider>
    </section>
  )
}
function Host({ enabled = true }: { enabled?: boolean }) {
  const [items, setItems] = useState([item])
  const board = useStandardCloudBoardController({
    items,
    extensions: {},
    fixedGroupBy: 'status',
    defaultGroupBy: 'status',
    focusStorageKey: null,
    personalGroupStorageKey: null,
    baseBoardStatusGrouping: false,
    createColumns: () => columns,
    tagLimitError: 'Too many tags',
    onMove: async (current, _column, _before, mutation) => {
      if (mutation.kind !== 'status') throw new Error('Unexpected mutation')
      const saved = await save(current, mutation.status)
      setItems(currentItems => currentItems.map(value => (value.id === saved.id ? saved : value)))
    },
  })
  return (
    <CollaborationTheme mode="dark">
      <output data-testid="saved">{JSON.stringify(items)}</output>
      <output data-testid="error">{board.moveError}</output>
      <ProjectBoardTransfer
        onDragStart={source => board.setActiveDragItemId(projectBoardDragItemId(source))}
        onDragCancel={() => board.setActiveDragItemId(null)}
        onDrop={drop => {
          board.setActiveDragItemId(null)
          board.moveDroppedItem(drop)
        }}
      >
        {columns.map(column => (
          <Column
            key={column.key}
            column={column}
            enabled={enabled}
            items={board.getColumnItems(column, board.state)}
          />
        ))}
      </ProjectBoardTransfer>
    </CollaborationTheme>
  )
}
function card() {
  const result = container.querySelector<HTMLButtonElement>('[data-testid="card-moving"]')
  if (!result) throw new Error('Missing card')
  return result
}
async function key(value: string) {
  await act(async () => {
    card().dispatchEvent(
      new KeyboardEvent('keydown', {
        key: value,
        code: value === ' ' ? 'Space' : value,
        bubbles: true,
        cancelable: true,
      })
    )
  })
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'PointerEvent',
    class PointerEvent extends MouseEvent {
      pointerId: number
      isPrimary: boolean
      pointerType: string
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init)
        this.pointerId = init.pointerId ?? 1
        this.isPrimary = init.isPrimary ?? true
        this.pointerType = init.pointerType ?? 'mouse'
      }
    }
  )
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: (x: number) => {
      const node = container.querySelector(
        '[data-testid="column-' + (x >= 200 ? 'completed' : 'pending') + '"]'
      )
      return node ? [node] : []
    },
  })
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.dataset.testid === 'column-completed') return new DOMRect(200, 0, 160, 300)
    if (this.dataset.testid === 'column-pending') return new DOMRect(0, 0, 160, 300)
    return new DOMRect(10, 10, 100, 40)
  })
  save.mockReset().mockImplementation(async (item, status) => ({ ...item, status }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'elementsFromPoint')
})

test('SDK cross-column keyboard drop persists through the real board controller exactly once', async () => {
  await act(async () => root.render(<Host />))
  act(() => card().focus())
  await key(' ')
  await key('ArrowRight')
  expect(save).not.toHaveBeenCalled()
  await key(' ')
  expect(save).toHaveBeenCalledExactlyOnceWith(item, 'completed')
  expect(document.activeElement).toBe(card())
  expect(container.querySelector('[data-testid="column-completed"]')?.textContent).toContain(
    'moving'
  )
  expect(container.querySelector('[data-testid="saved"]')?.textContent).toContain('keep-tag')
})
test('SDK cancel and readonly cards do not persist cross-column drafts', async () => {
  await act(async () => root.render(<Host />))
  act(() => card().focus())
  await key(' ')
  await key('ArrowRight')
  await key('Escape')
  expect(save).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(card())
  await act(async () => root.render(<Host enabled={false} />))
  await key(' ')
  await key('ArrowRight')
  await key(' ')
  expect(save).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="column-pending"]')?.textContent).toContain('moving')
})
test('a rejected persist leaves the source data and reports the existing move error', async () => {
  save.mockRejectedValue(new Error('write failed'))
  await act(async () => root.render(<Host />))
  await key(' ')
  await key('ArrowRight')
  await key(' ')
  expect(save).toHaveBeenCalledOnce()
  expect(container.querySelector('[data-testid="column-pending"]')?.textContent).toContain('moving')
  expect(container.querySelector('[data-testid="saved"]')?.textContent).toContain('keep-tag')
  expect(container.querySelector('[data-testid="error"]')?.textContent).toBe('write failed')
})

function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    })
  )
}
async function beginPointer() {
  await act(async () => {
    pointer(card(), 'pointerdown', 20, 20)
    pointer(document, 'pointermove', 260, 40)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}
test('SDK pointer transfer renders one themed preview and persists the real destination', async () => {
  await act(async () => root.render(<Host />))
  await beginPointer()
  const copy = document.querySelector<HTMLElement>('[data-testid="project-board-drag-overlay"]')
  expect(copy).not.toBeNull()
  expect(copy?.dataset.theme).toBe('dark')
  expect(document.querySelectorAll('[data-testid="card-moving"]')).toHaveLength(1)
  await act(async () => pointer(document, 'pointerup', 260, 40))
  expect(save).toHaveBeenCalledExactlyOnceWith(item, 'completed')
  expect(document.querySelector('[data-testid="project-board-drag-overlay"]')).toBeNull()
})
test('release outside all lanes cancels a hovered cross-column draft', async () => {
  await act(async () => root.render(<Host />))
  await beginPointer()
  await act(async () => pointer(document, 'pointerup', 600, 500))
  expect(save).not.toHaveBeenCalled()
  expect(container.querySelector('[data-testid="column-pending"]')?.textContent).toContain('moving')
})

test('focus recovery does not steal a new external focus while persistence is pending', async () => {
  let resolveSave: (saved: StandardCloudBoardItem) => void = () => {
    throw new Error('Save not started')
  }
  save.mockImplementation(
    () =>
      new Promise(resolve => {
        resolveSave = resolve
      })
  )
  await act(async () => root.render(<Host />))
  act(() => card().focus())
  await key(' ')
  await key('ArrowRight')
  await key(' ')
  const external = document.createElement('button')
  document.body.append(external)
  act(() => external.focus())
  await act(async () => resolveSave({ ...item, status: 'completed' }))
  expect(container.querySelector('[data-testid="column-completed"]')?.textContent).toContain(
    'moving'
  )
  expect(document.activeElement).toBe(external)
  external.remove()
})

test('pointer transfer follows the displayed card order after an in-place sort change', async () => {
  const anchor = { ...item, id: 'anchor' }
  const first = { ...item, id: 'first' }
  const onDrop = vi.fn()
  function Board({ items }: { items: StandardCloudBoardItem[] }) {
    return (
      <ProjectBoardTransfer onDrop={onDrop}>
        <Column column={columns[0]} items={items} enabled />
      </ProjectBoardTransfer>
    )
  }
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (
    this: HTMLElement
  ) {
    if (this.matches('section')) return new DOMRect(0, 0, 160, 300)
    const lane = this.closest('section')
    const index = lane ? Array.from(lane.children).findIndex(child => child.contains(this)) : -1
    return new DOMRect(10, 20 + index * 80, 100, 40)
  })
  await act(async () => root.render(<Board items={[anchor, item, first]} />))
  const source = card()
  await act(async () => root.render(<Board items={[first, anchor, item]} />))
  expect(card()).toBe(source)
  await act(async () => {
    pointer(source, 'pointerdown', 20, 190)
    pointer(document, 'pointermove', 40, 190)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  await act(async () => {
    pointer(document, 'pointermove', 40, 110)
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  await act(async () => {
    pointer(document, 'pointerup', 40, 110)
  })
  expect(onDrop).toHaveBeenCalledExactlyOnceWith({
    activeItemId: item.id,
    beforeItemId: anchor.id,
    sourceColumnKey: 'pending',
    columnDropKey: 'pending',
    groupBy: 'status',
  })
})
