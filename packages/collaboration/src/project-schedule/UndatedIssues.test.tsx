// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'
import { addLocalDays, defaultScheduleViewOptions, localDateKey } from './model'
import { ProjectGanttView } from './ProjectGanttView'
import { CollaborationTheme } from '../theme'

const issue = {
  id: 'undated-issue',
  title: 'Schedule this task',
  start_at: null,
  due_at: null,
  status: 'pending',
  priority: 'none',
  tags: [],
  can_edit: true,
} as unknown as CollaborationIssue

let hit: Element | null = null
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

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
    },
  )
  Object.defineProperty(document, 'elementsFromPoint', {
    configurable: true,
    value: () => (hit ? [hit] : []),
  })
  vi.spyOn(window, 'scrollBy').mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(10, 300, 180, 32),
  )
  hit = null
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

function render(issues = [issue], onSchedule = vi.fn()) {
  act(() => {
    root.render(
      <CollaborationTheme mode="dark">
        <ProjectGanttView
          issues={issues}
          statuses={[{ id: 'pending', name: 'Pending', color: 'orange' }]}
          locale="en"
          viewOptions={defaultScheduleViewOptions}
          onOpen={vi.fn()}
          onSchedule={onSchedule}
        />
      </CollaborationTheme>,
    )
  })
  return onSchedule
}

function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      pointerType: 'mouse',
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  )
}
async function startDrag(
  selector = '[data-testid="collaboration-schedule-undated-undated-issue"]',
) {
  const source = container.querySelector<HTMLElement>(selector)
  if (!source) throw new Error('Missing undated task')
  await act(async () => {
    pointer(source, 'pointerdown', 20, 310)
    pointer(document, 'pointermove', 70, 10)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
function release() {
  act(() => pointer(document, 'pointerup', 70, 10))
}

const overlay = () =>
  document.querySelector(
    '[data-testid="collaboration-schedule-undated-drag-overlay"]',
  )

describe('undated schedule dragging', () => {
  it('keeps the dragged task outside the clipping scroll container and restores it on cancel', async () => {
    render()
    expect(overlay()).toBeNull()
    await startDrag()

    expect(overlay()?.textContent).toContain(issue.title)
    expect(overlay()?.parentElement).toBe(document.body)
    expect(overlay()?.getAttribute('data-theme')).toBe('dark')
    expect(container.contains(overlay())).toBe(false)
    const source = container.querySelector<HTMLElement>(
      '[data-testid="collaboration-schedule-undated-undated-issue"]',
    )!
    expect(source.closest('section')?.className).toContain('overflow-auto')
    expect(source.style.transform).toBe('')

    act(() =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      ),
    )
    expect(overlay()).toBeNull()
    expect(source.isConnected).toBe(true)
  })

  it('saves the dropped date and renders the task in the Gantt after the saved issue arrives', async () => {
    const onSchedule = render()
    await startDrag()
    const date = localDateKey(new Date())
    hit = container.querySelector(
      '[data-testid="collaboration-gantt-header-day-' + date + '"]',
    )
    release()
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(issue, {
      startAt: date,
      dueAt: date,
    })
    expect(overlay()).toBeNull()
    render([{ ...issue, start_at: date, due_at: date }], onSchedule)
    expect(
      container.querySelector(
        '[data-testid="collaboration-gantt-issue-undated-issue"]',
      ),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[data-testid="collaboration-schedule-undated-undated-issue"]',
      ),
    ).toBeNull()
  })

  it('keeps the task unscheduled when released outside a date target', async () => {
    const onSchedule = render()
    await startDrag()
    hit = null
    release()
    expect(onSchedule).not.toHaveBeenCalled()
    expect(overlay()).toBeNull()
    expect(container.textContent).toContain(issue.title)
  })
})

it.each(['start', 'end'] as const)(
  'SDK %s resize preserves the other date and task identity',
  async (mode) => {
    const start = localDateKey(new Date())
    const due = localDateKey(addLocalDays(new Date(), 2))
    const date = localDateKey(addLocalDays(new Date(), 1))
    const scheduled = { ...issue, start_at: start, due_at: due }
    const onSchedule = render([scheduled])
    hit = container.querySelector(
      `[data-testid="collaboration-gantt-header-day-${date}"]`,
    )
    await startDrag(
      `[data-testid="collaboration-gantt-issue-undated-issue-${mode}-handle"]`,
    )
    release()
    expect(onSchedule).toHaveBeenCalledExactlyOnceWith(scheduled, {
      startAt: mode === 'start' ? date : start,
      dueAt: mode === 'end' ? date : due,
    })
  },
)

it('revoked edit permission cancels an active schedule gesture without persisting', async () => {
  const onSchedule = render()
  await startDrag()
  const date = localDateKey(new Date())
  hit = container.querySelector(
    `[data-testid="collaboration-gantt-header-day-${date}"]`,
  )
  render([{ ...issue, can_edit: false }], onSchedule)
  release()
  expect(onSchedule).not.toHaveBeenCalled()
  expect(overlay()).toBeNull()
  expect(container.textContent).toContain(issue.title)
})
