import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExperienceNavigation } from './ExperienceNavigation'
import { ExperiencePanes } from './ExperiencePanes'
import type { ExperiencePane } from './types'

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let availableWidth = 1440
let styleElement: HTMLStyleElement
const styles = readFileSync('src/features/collaboration-exp/shell/ExperienceApp.css', 'utf8')

function paneRect(element: HTMLElement): DOMRect {
  const group = element.closest<HTMLElement>('[data-group]')
  if (!group || element === group) return new DOMRect(0, 0, availableWidth, 844)
  const children = Array.from(group.children).filter(
    (child): child is HTMLElement => child instanceof HTMLElement
  )
  const panels = children.filter(child => child.hasAttribute('data-panel'))
  const contentWidth = availableWidth - (panels.length - 1) * 8
  const total = panels.reduce((sum, pane) => sum + Number(pane.style.flexGrow || 1), 0)
  const widthOf = (child: HTMLElement) =>
    child.hasAttribute('data-panel')
      ? (Number(child.style.flexGrow || 1) / total) * contentWidth
      : 8
  const target = children.find(child => child === element || child.contains(element))
  let left = 0
  for (const child of children) {
    if (child === target) return new DOMRect(left, 0, widthOf(child), 844)
    left += widthOf(child)
  }
  return new DOMRect(0, 0, availableWidth, 844)
}

function resize(width: number) {
  availableWidth = width
  act(() => window.dispatchEvent(new Event('resize')))
}

function visiblePaneIds() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-experience-pane-host]'))
    .filter(element => !element.closest('[hidden]'))
    .map(element => element.dataset.experiencePaneHost)
}

function panelLayout() {
  return Object.fromEntries(
    Array.from(document.querySelectorAll<HTMLElement>('[data-panel]')).map(panel => [
      panel.id,
      Number(panel.style.flexGrow),
    ])
  )
}

beforeEach(() => {
  availableWidth = 1440
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    return paneRect(this)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
    return paneRect(this).width
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(844)
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function () {
    return paneRect(this).left
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(0)
  styleElement = document.createElement('style')
  styleElement.textContent = styles
  document.head.append(styleElement)
})

afterEach(() => {
  cleanup()
  styleElement.remove()
  document.documentElement.classList.remove('dark')
  vi.restoreAllMocks()
})

function Draft() {
  const [value, setValue] = useState('')
  return (
    <input
      aria-label="Private draft"
      value={value}
      onChange={event => setValue(event.target.value)}
    />
  )
}

function LayerFixture() {
  const [depth, setDepth] = useState(1)
  const panes: ExperiencePane[] = [
    {
      id: 'list',
      title: 'Tasks',
      minWidth: 280,
      defaultWidth: 350,
      content: (
        <button data-testid="open-task" onClick={() => setDepth(2)}>
          Task one
        </button>
      ),
    },
    {
      id: 'timeline',
      title: 'Task timeline',
      minWidth: 320,
      content: (
        <button data-testid="open-discussion" onClick={() => setDepth(3)}>
          Private discussion
        </button>
      ),
    },
    { id: 'discussion', title: 'Private discussion', minWidth: 320, content: <Draft /> },
  ]
  return (
    <ExperiencePanes
      navigation={<div>Navigation</div>}
      panes={panes.slice(0, depth)}
      onBack={() => setDepth(value => value - 1)}
    />
  )
}

describe('ExperiencePanes', () => {
  it('shows navigation and all layers when minima fit and progressively hides the oldest layers', () => {
    render(<LayerFixture />)
    fireEvent.click(screen.getByTestId('open-task'))
    fireEvent.click(screen.getByTestId('open-discussion'))
    expect(visiblePaneIds()).toEqual([
      'collaboration-exp-navigation',
      'list',
      'timeline',
      'discussion',
    ])
    expect(screen.getAllByRole('separator')).toHaveLength(3)

    resize(1103)
    expect(visiblePaneIds()).toEqual(['collaboration-exp-navigation', 'timeline', 'discussion'])
    resize(767)
    expect(visiblePaneIds()).toEqual(['discussion'])
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    resize(1440)
    expect(visiblePaneIds()).toEqual([
      'collaboration-exp-navigation',
      'list',
      'timeline',
      'discussion',
    ])
  })

  it('returns one mobile layer at a time and restores the exact triggering control', () => {
    availableWidth = 390
    render(<LayerFixture />)
    const task = screen.getByTestId('open-task')
    task.focus()
    fireEvent.click(task)
    expect(visiblePaneIds()).toEqual(['timeline'])
    expect(screen.getByTestId('collaboration-exp-pane-timeline')).toHaveFocus()
    const discussion = screen.getByTestId('open-discussion')
    discussion.focus()
    fireEvent.click(discussion)
    expect(visiblePaneIds()).toEqual(['discussion'])
    fireEvent.click(screen.getByTestId('collaboration-exp-pane-header-discussion-back'))
    expect(visiblePaneIds()).toEqual(['timeline'])
    expect(discussion).toHaveFocus()
    fireEvent.click(screen.getByTestId('collaboration-exp-pane-header-timeline-back'))
    expect(visiblePaneIds()).toEqual(['list'])
    expect(task).toHaveFocus()
    expect(screen.queryByTestId('collaboration-exp-pane-header-list-back')).not.toBeInTheDocument()
  })

  it('retains private drafts and mounted controls while panes move between desktop and mobile', () => {
    render(<LayerFixture />)
    fireEvent.click(screen.getByTestId('open-task'))
    fireEvent.click(screen.getByTestId('open-discussion'))
    const input = screen.getByRole('textbox', { name: 'Private draft' })
    fireEvent.change(input, { target: { value: 'Keep my unsent text' } })
    resize(390)
    resize(1440)
    expect(screen.getByRole('textbox', { name: 'Private draft' })).toBe(input)
    expect(input).toHaveValue('Keep my unsent text')
  })

  it('uses the shared separator keyboard resize, preserves total width and restores defaults on double click', () => {
    render(
      <ExperiencePanes
        panes={[
          { id: 'list', title: 'Tasks', content: null, minWidth: 280, defaultWidth: 350 },
          { id: 'timeline', title: 'Timeline', content: null, minWidth: 320 },
        ]}
      />
    )
    const separator = screen.getByRole('separator')
    const original = panelLayout()
    act(() => separator.focus())
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    const enlarged = panelLayout()
    expect(enlarged.list).toBeGreaterThan(original.list)
    expect(enlarged.timeline).toBeLessThan(original.timeline)
    expect(enlarged.list + enlarged.timeline).toBeCloseTo(100)
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(panelLayout().list).toBeCloseTo(original.list)
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    fireEvent.doubleClick(separator)
    expect(panelLayout().list).toBeCloseTo(original.list)
    expect(panelLayout().timeline).toBeCloseTo(original.timeline)
  })

  it('cancels the active pointer resize on Escape without allowing an outer layer-close handler', () => {
    const close = vi.fn()
    render(
      <div
        onKeyDown={event => {
          if (event.key === 'Escape') close()
        }}
      >
        <ExperiencePanes
          panes={[
            { id: 'list', title: 'Tasks', content: null, minWidth: 280, defaultWidth: 350 },
            { id: 'timeline', title: 'Timeline', content: null, minWidth: 320 },
          ]}
        />
      </div>
    )
    const separator = screen.getByRole('separator')
    const original = panelLayout()
    const x = separator.getBoundingClientRect().left + 4
    fireEvent.pointerDown(separator, {
      clientX: x,
      clientY: 100,
      button: 0,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
    })
    fireEvent.pointerMove(separator, {
      clientX: x + 100,
      clientY: 100,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
    })
    expect(panelLayout().list).toBeGreaterThan(original.list)
    fireEvent.keyDown(separator, { key: 'Escape' })
    expect(panelLayout().list).toBeCloseTo(original.list)
    expect(separator).not.toHaveAttribute('data-separator', 'active')
    expect(close).not.toHaveBeenCalled()
    fireEvent.pointerMove(separator, {
      clientX: x + 200,
      clientY: 100,
      buttons: 1,
      pointerType: 'mouse',
      pointerId: 1,
    })
    expect(panelLayout().list).toBeCloseTo(original.list)
    fireEvent.pointerUp(separator, {
      clientX: x + 200,
      clientY: 100,
      buttons: 0,
      pointerType: 'mouse',
      pointerId: 1,
    })
  })

  it('keeps the same themed DOM and contains long content inside a scrollable edge-aligned body', () => {
    availableWidth = 390
    render(
      <ExperiencePanes
        panes={[
          {
            id: 'attachments',
            title: 'Very long title '.repeat(40),
            content: (
              <ul>
                {Array.from({ length: 60 }, (_, index) => (
                  <li key={index}>{'long-attachment-name'.repeat(20)}</li>
                ))}
              </ul>
            ),
          },
        ]}
      />
    )
    const shell = screen.getByTestId('collaboration-exp-panes')
    const lightDom = shell.innerHTML
    document.documentElement.classList.add('dark')
    expect(shell.innerHTML).toBe(lightDom)
    const body = shell.querySelector<HTMLElement>('.experience-pane-body')!
    expect(getComputedStyle(body).overflowX).toBe('hidden')
    expect(getComputedStyle(body).overflowY).toBe('auto')
    expect(getComputedStyle(body).paddingRight).toBe('')
    expect(getComputedStyle(shell).overflow).toBe('hidden')
    expect(within(body).getAllByRole('listitem')).toHaveLength(60)
  })

  it('uses full rectangular navigation rows and preserves project/footer slots', () => {
    const change = vi.fn()
    render(
      <ExperienceNavigation
        activeView="tasks"
        onViewChange={change}
        projectNavigation={<button>Project A</button>}
        footer={<button>Private settings</button>}
      />
    )
    expect(screen.getByTestId('collaboration-exp-navigation-tasks')).toHaveAttribute(
      'aria-current',
      'page'
    )
    fireEvent.click(screen.getByTestId('collaboration-exp-navigation-assistant'))
    expect(change).toHaveBeenCalledWith('assistant')
    expect(screen.getByRole('button', { name: 'Project A' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Private settings' })).toBeInTheDocument()
  })
})
