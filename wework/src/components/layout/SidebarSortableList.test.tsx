import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import '@/i18n'
import { SidebarSortableList } from './SidebarSortableList'
import {
  WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT,
  WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT,
  type WorkbenchSidebarPaneDragEndData,
} from './workbenchPaneDrag'

const items = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
  { id: 'c', title: 'Gamma' },
]
type SidebarItem = (typeof items)[number]
type Move = (item: SidebarItem, before: SidebarItem | null) => Promise<void>
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const row = this.closest<HTMLElement>('[data-sidebar-sortable-id]')
    const index = row
      ? [...container.querySelectorAll('[data-sidebar-sortable-id]')].indexOf(row)
      : 0
    return new DOMRect(0, index * 40, 200, row ? 40 : 120)
  })
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const find = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!
const order = () =>
  [...container.querySelectorAll('[data-sidebar-sortable-id]')].map(el =>
    el.getAttribute('data-sidebar-sortable-id')
  )
async function key(target: HTMLElement, value: string) {
  await act(async () => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true })
    )
  })
}
async function mount(
  onMove: (item: (typeof items)[number], before: (typeof items)[number] | null) => Promise<void>,
  external = false,
  draggable = true
) {
  await act(async () =>
    root.render(
      <SidebarSortableList
        items={items}
        getId={item => item.id}
        getLabel={item => item.title}
        testId="tasks"
        accessibleLabel="Tasks"
        canDrag={() => draggable}
        getExternalDragData={
          external ? item => ({ paneKey: item.id, title: item.title }) : undefined
        }
        onMove={onMove}
        renderItem={item => (
          <div>
            <button data-sidebar-drag-activator data-testid={`title-${item.id}`}>
              {item.title}
            </button>
            <input data-testid={`rename-${item.id}`} />
          </div>
        )}
      />
    )
  )
}
async function pointer(type: string, target: EventTarget, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(
      new PointerEvent(type, {
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        bubbles: true,
        cancelable: true,
      })
    )
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
}
it('does not sort nested controls, keeps keyboard cancel local and rolls back failed persistence', async () => {
  let reject!: (cause: Error) => void
  const moved = vi.fn<Move>(
    () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail
      })
  )
  await mount(moved)
  await key(find('rename-a'), ' ')
  await key(find('title-a'), ' ')
  expect(moved).not.toHaveBeenCalled()
  expect(container.querySelector('[data-dragging="true"]')).toBeNull()
  const handle = find('tasks-handle-a')
  handle.focus()
  await key(handle, ' ')
  await key(handle, 'End')
  expect(order()).toEqual(['b', 'c', 'a'])
  await key(handle, 'Escape')
  expect(order()).toEqual(['a', 'b', 'c'])
  expect(moved).not.toHaveBeenCalled()
  await key(handle, ' ')
  await key(handle, 'ArrowDown')
  await key(handle, ' ')
  expect(moved).toHaveBeenCalledExactlyOnceWith(items[0], items[2])
  expect(moved.mock.calls[0][0]).toBe(items[0])
  expect(moved.mock.calls[0][1]).toBe(items[2])
  expect(order()).toEqual(['b', 'a', 'c'])
  await act(async () => reject(new Error('Persistence failed')))
  expect(order()).toEqual(['a', 'b', 'c'])
  expect(document.activeElement).toBe(handle)
})
it('uses the SDK pointer reorder and keeps original domain objects', async () => {
  const moved = vi.fn<Move>(async () => {})
  await mount(moved)
  await pointer('pointerdown', find('title-a'), 30, 20)
  await pointer('pointermove', document.body, 30, 65)
  await pointer('pointerup', document.body, 30, 65)
  expect(moved).toHaveBeenCalledExactlyOnceWith(items[0], items[2])
  expect(moved.mock.calls[0][0]).toBe(items[0])
  expect(moved.mock.calls[0][1]).toBe(items[2])
  expect(order()).toEqual(['b', 'a', 'c'])
})
it('lets an external-only task open a pane on a same-position drop without persisting a reorder', async () => {
  const moved = vi.fn<Move>(async () => {})
  const started = vi.fn()
  const ended = vi.fn()
  const start = () => started()
  const end = (event: Event) =>
    ended((event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail)
  window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, start)
  window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, end)
  try {
    await mount(moved, true, false)
    expect(container.querySelector('[data-slot="sortable-handle"]')).toBeNull()
    await pointer('pointerdown', find('title-a'), 30, 20)
    await pointer('pointermove', document.body, 260, 20)
    await pointer('pointerup', document.body, 260, 20)
    expect(started).toHaveBeenCalledOnce()
    expect(ended).toHaveBeenCalledExactlyOnceWith({
      paneKey: 'a',
      title: 'Alpha',
      clientX: 260,
      clientY: 20,
      handled: false,
    })
    expect(moved).not.toHaveBeenCalled()
    expect(order()).toEqual(['a', 'b', 'c'])
  } finally {
    window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_START_EVENT, start)
    window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, end)
  }
})
it.each(['outside', 'handled'] as const)(
  'does not persist a pointer reorder consumed by %s policy',
  async policy => {
    const moved = vi.fn<Move>(async () => {})
    const ended = vi.fn()
    const receive = (event: Event) => {
      const data = (event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail
      if (data && policy === 'handled') data.handled = true
      ended(data)
    }
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, receive)
    try {
      await mount(moved, true)
      await pointer('pointerdown', find('title-a'), 30, 20)
      await pointer('pointermove', document.body, policy === 'outside' ? 260 : 30, 65)
      if (policy === 'outside') expect(order()).toEqual(['a', 'b', 'c'])
      await pointer('pointerup', document.body, policy === 'outside' ? 260 : 30, 65)
      expect(ended).toHaveBeenCalledOnce()
      expect(ended.mock.calls[0][0]?.handled).toBe(policy === 'handled')
      expect(moved).not.toHaveBeenCalled()
      expect(order()).toEqual(['a', 'b', 'c'])
    } finally {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, receive)
    }
  }
)
it.each(['Escape', 'blur', 'pointercancel', 'lostpointercapture', 'unmount'] as const)(
  'cancels external pane drag on %s instead of turning it into a drop',
  async reason => {
    const moved = vi.fn<Move>(async () => {})
    const ended = vi.fn()
    const receive = (event: Event) =>
      ended((event as CustomEvent<WorkbenchSidebarPaneDragEndData | null>).detail)
    window.addEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, receive)
    try {
      await mount(moved, true)
      await pointer('pointerdown', find('title-a'), 30, 20)
      await pointer('pointermove', document.body, 260, 65)
      if (reason === 'Escape') await key(document.body, 'Escape')
      else if (reason === 'blur') await act(async () => window.dispatchEvent(new Event('blur')))
      else if (reason === 'unmount') await act(async () => root.render(null))
      else await pointer(reason, find('title-a').closest('[data-slot="sortable-item"]')!, 260, 65)
      await pointer('pointerup', document.body, 260, 65)
      expect(ended).toHaveBeenCalledExactlyOnceWith(null)
      expect(moved).not.toHaveBeenCalled()
      if (reason !== 'unmount') expect(order()).toEqual(['a', 'b', 'c'])
    } finally {
      window.removeEventListener(WORKBENCH_SIDEBAR_PANE_DRAG_END_EVENT, receive)
    }
  }
)
