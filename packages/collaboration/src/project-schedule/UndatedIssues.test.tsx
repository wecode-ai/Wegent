// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core'
import type { CollaborationIssue } from '../types'
import {
  defaultScheduleViewOptions,
  localDateKey,
  scheduleDateDropId,
  scheduleIssueDragId,
} from './model'
import { ProjectGanttView } from './ProjectGanttView'
import { CollaborationTheme } from '../theme'

const dnd = vi.hoisted(() => ({
  handlers: {} as {
    onDragStart(event: DragStartEvent): void
    onDragEnd(event: DragEndEvent): void
    onDragCancel(): void
  },
}))

vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@dnd-kit/core')>()),
  DndContext: ({ children, ...handlers }: { children: ReactNode }) => {
    dnd.handlers = handlers as typeof dnd.handlers
    return children
  },
  DragOverlay: ({ children }: { children: ReactNode }) => children,
  useDroppable: () => ({ setNodeRef: vi.fn(), isOver: false }),
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: true,
    transform: { x: 50, y: -300 },
  }),
}))

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

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

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

function startDrag() {
  act(() =>
    dnd.handlers.onDragStart({
      active: { id: scheduleIssueDragId(issue.id) },
    } as DragStartEvent),
  )
}

const overlay = () =>
  document.querySelector(
    '[data-testid="collaboration-schedule-undated-drag-overlay"]',
  )

describe('undated schedule dragging', () => {
  it('keeps the dragged task outside the clipping scroll container and restores it on cancel', () => {
    render()
    expect(overlay()).toBeNull()
    startDrag()

    expect(overlay()?.textContent).toContain(issue.title)
    expect(overlay()?.parentElement).toBe(document.body)
    expect(overlay()?.getAttribute('data-theme')).toBe('dark')
    expect(container.contains(overlay())).toBe(false)
    const source = container.querySelector<HTMLElement>(
      '[data-testid="collaboration-schedule-undated-undated-issue"]',
    )!
    expect(source.closest('section')?.className).toContain('overflow-auto')
    expect(source.style.transform).toBe('')

    act(() => dnd.handlers.onDragCancel())
    expect(overlay()).toBeNull()
    expect(source.isConnected).toBe(true)
  })

  it('saves the dropped date and renders the task in the Gantt after the saved issue arrives', () => {
    const onSchedule = render()
    startDrag()
    const date = localDateKey(new Date())
    act(() =>
      dnd.handlers.onDragEnd({
        active: { id: scheduleIssueDragId(issue.id) },
        over: { id: scheduleDateDropId(date, 'gantt-header') },
      } as DragEndEvent),
    )
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

  it('keeps the task unscheduled when released outside a date target', () => {
    const onSchedule = render()
    startDrag()
    act(() =>
      dnd.handlers.onDragEnd({
        active: { id: scheduleIssueDragId(issue.id) },
        over: null,
      } as DragEndEvent),
    )
    expect(onSchedule).not.toHaveBeenCalled()
    expect(overlay()).toBeNull()
    expect(container.textContent).toContain(issue.title)
  })
})
