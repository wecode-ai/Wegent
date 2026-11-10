// @vitest-environment jsdom

import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CollaborationTheme } from '../theme'
import {
  ProjectViewSwitcher,
  createProjectViewSelectionMemory,
  groupedProjectViewMetadata,
  type CollaborationProjectView,
  type CollaborationProjectViewOption,
  type ProjectViewSwitcherProps,
} from './ProjectViewSwitcher'

const names = {
  board: '看板',
  calendar: '日历',
  gantt: '甘特',
  table: '表格',
  milestones: '里程碑',
  files: '文件',
  manage: '项目设置',
}
const ids: CollaborationProjectView[] = [
  'board',
  'calendar',
  'gantt',
  'table',
  'milestones',
  'files',
  'manage',
]
const options: CollaborationProjectViewOption[] = ids.map((id) => ({
  id,
  label: names[id],
  testId: `view-${id}`,
  ...groupedProjectViewMetadata[id],
}))

let root: Root
let container: HTMLDivElement
const change = vi.fn()

function Harness({
  value: initialValue = 'board',
  ...props
}: Partial<ProjectViewSwitcherProps>) {
  const [value, setValue] = useState(initialValue)
  return (
    <ProjectViewSwitcher
      compact={false}
      options={options}
      {...props}
      value={value}
      onChange={(next) => {
        change(next)
        setValue(next)
      }}
    />
  )
}

function render(node: ReactNode) {
  act(() => root.render(node))
}
function byId(id: string) {
  const node = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!node) throw new Error(`Missing element: ${id}`)
  return node
}
async function click(id: string) {
  await act(async () => byId(id).click())
}
const tabLabels = (selector: string) =>
  [...container.querySelectorAll(`${selector} [role="tab"]`)].map(
    (node) => node.textContent,
  )

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  change.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('grouped project navigation', () => {
  it('keeps segment aliases unique when timeline has a separate parent entry', () => {
    render(
      <Harness
        value="gantt"
        options={options.map((option) => ({
          ...option,
          oldTestIdAliases: [`previous-${option.id}`],
        }))}
      />,
    )
    for (const view of ['board', 'calendar', 'gantt']) {
      const matches = document.querySelectorAll(
        `[data-testid="previous-${view}"]`,
      )
      expect(matches).toHaveLength(1)
      expect(matches[0].closest('button')?.dataset.testid).toBe(`view-${view}`)
    }
    expect(
      byId('collaboration-sub-timeline').querySelector('[data-testid]'),
    ).toBeNull()
  })
  it('shows ordered primary entries, enters gantt by default and releases the secondary row on work', async () => {
    render(<Harness />)
    expect(tabLabels('.project-view-switcher-primary')).toEqual([
      '工作',
      '计划',
      '管理',
    ])
    expect(
      container.querySelector(
        '[data-testid="collaboration-project-secondary"]',
      ),
    ).toBeNull()
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('gantt')
    expect(tabLabels('.project-view-switcher-tabs')).toEqual([
      '时间线',
      '里程碑',
      '表格',
    ])
    expect(
      byId('collaboration-sub-timeline').getAttribute('aria-selected'),
    ).toBe('true')
    expect(byId('view-gantt').getAttribute('aria-pressed')).toBe('true')
    expect(
      [
        ...container.querySelectorAll('.project-view-switcher-segments button'),
      ].map((node) => node.textContent),
    ).toEqual(['日历', '甘特'])
    await click('view-board')
    expect(
      container.querySelector(
        '[data-testid="collaboration-project-secondary"]',
      ),
    ).toBeNull()
  })

  it('remembers plan choices but always enters files when returning to management', async () => {
    render(<Harness />)
    await click('collaboration-tab-plan')
    await click('view-milestones')
    await click('view-board')
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('milestones')
    await click('collaboration-tab-admin')
    expect(tabLabels('.project-view-switcher-tabs')).toEqual([
      '文件',
      '项目设置',
    ])
    expect(change).toHaveBeenLastCalledWith('files')
    await click('view-manage')
    await click('view-board')
    await click('collaboration-tab-admin')
    expect(change).toHaveBeenLastCalledWith('files')
  })

  it('keeps calendar and gantt as independent controlled view IDs', async () => {
    render(<Harness value="calendar" />)
    expect(change).not.toHaveBeenCalled()
    expect(byId('view-calendar').getAttribute('aria-pressed')).toBe('true')
    await click('view-gantt')
    expect(change).toHaveBeenLastCalledWith('gantt')
    await click('view-milestones')
    await click('collaboration-sub-timeline')
    expect(change).toHaveBeenLastCalledWith('gantt')
  })

  it('isolates projects, identities and sessions while allowing a host-owned session across remounts', async () => {
    const memory = createProjectViewSelectionMemory()
    render(
      <Harness
        key="a1"
        selectionMemory={memory}
        selectionKey="user-a:local:project-1"
      />,
    )
    await click('collaboration-tab-plan')
    await click('view-milestones')
    for (const key of [
      'user-a:local:project-2',
      'user-a:backend:project-1',
      'user-b:local:project-1',
    ]) {
      render(<Harness key={key} selectionMemory={memory} selectionKey={key} />)
      await click('collaboration-tab-plan')
      expect(change).toHaveBeenLastCalledWith('gantt')
    }
    render(
      <Harness
        key="a2"
        selectionMemory={memory}
        selectionKey="user-a:local:project-1"
      />,
    )
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('milestones')
    render(
      <Harness
        key="refreshed"
        selectionMemory={createProjectViewSelectionMemory()}
        selectionKey="user-a:local:project-1"
      />,
    )
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('gantt')
  })

  it('lets an explicit deep link override memory and never navigates while mounting', async () => {
    const memory = createProjectViewSelectionMemory()
    memory.set('project', { planView: 'milestones', timelineView: 'calendar' })
    render(
      <Harness value="gantt" selectionMemory={memory} selectionKey="project" />,
    )
    expect(change).not.toHaveBeenCalled()
    expect(byId('view-gantt').getAttribute('aria-pressed')).toBe('true')
    await click('view-board')
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('gantt')
  })

  it('hides unavailable entries and revalidates a remembered plan view', async () => {
    const memory = createProjectViewSelectionMemory()
    memory.set('project', { planView: 'milestones' })
    render(
      <Harness
        selectionMemory={memory}
        selectionKey="project"
        options={options.filter(
          (option) => !['manage', 'milestones'].includes(option.id),
        )}
      />,
    )
    await click('collaboration-tab-admin')
    expect(tabLabels('.project-view-switcher-tabs')).toEqual(['文件'])
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('gantt')
    expect(tabLabels('.project-view-switcher-tabs')).toEqual(['时间线', '表格'])
    render(
      <Harness
        key="restricted"
        options={options.filter((option) => option.group !== 'admin')}
      />,
    )
    expect(tabLabels('.project-view-switcher-primary')).toEqual([
      '工作',
      '计划',
    ])
  })

  it('supports a calendar-only timeline and a settings-only management group', async () => {
    render(
      <Harness
        options={options.filter(
          (option) => !['gantt', 'files'].includes(option.id),
        )}
      />,
    )
    await click('collaboration-tab-plan')
    expect(change).toHaveBeenLastCalledWith('calendar')
    await click('collaboration-tab-admin')
    expect(change).toHaveBeenLastCalledWith('manage')
  })

  it.each(['table', 'files', 'manage'] as const)(
    'keeps the old %s selector actionable without duplicate IDs',
    async (view) => {
      render(<Harness value={view === 'table' ? 'gantt' : 'files'} />)
      const alias = byId(`collaboration-tab-${view}`)
      expect(alias.closest('button')?.dataset.testid).toBe(`view-${view}`)
      await click(`collaboration-tab-${view}`)
      expect(change).toHaveBeenLastCalledWith(view)
      expect(
        document.querySelectorAll(`[data-testid="collaboration-tab-${view}"]`),
      ).toHaveLength(1)
    },
  )

  it('supports keyboard selection on both tab rows', async () => {
    render(<Harness />)
    await act(async () => {
      byId('view-board').focus()
      byId('view-board').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      )
    })
    expect(change).toHaveBeenLastCalledWith('gantt')
    await act(async () => {
      byId('collaboration-sub-timeline').focus()
      byId('collaboration-sub-timeline').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      )
    })
    expect(change).toHaveBeenLastCalledWith('table')
  })
})

describe('compact navigation', () => {
  it('keeps timeline segments outside the menu and selects a real leaf through the menu', async () => {
    render(<Harness value="gantt" compact />)
    expect(tabLabels('.project-view-switcher-primary')).toEqual([
      '工作',
      '计划',
      '管理',
    ])
    expect(container.querySelector('.project-view-switcher-tabs')).toBeNull()
    expect(byId('view-calendar').closest('[role="menu"]')).toBeNull()
    await click('collaboration-compact-trigger')
    expect(
      [...document.querySelectorAll('[role="menuitemradio"]')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['时间线', '里程碑', '表格'])
    expect(
      byId('collaboration-sub-timeline').getAttribute('aria-checked'),
    ).toBe('true')
    await click('view-table')
    expect(change).toHaveBeenLastCalledWith('table')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(byId('collaboration-compact-trigger').textContent).toContain('表格')
    expect(
      container.querySelector('.project-view-switcher-segments'),
    ).toBeNull()
  })

  it('handles menu keyboard navigation and Escape', async () => {
    render(<Harness value="gantt" compact />)
    await click('collaboration-compact-trigger')
    await act(async () => {
      byId('collaboration-sub-timeline').focus()
      byId('collaboration-sub-timeline').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      )
    })
    expect(document.activeElement).toBe(byId('view-table'))
    await act(async () => {
      byId('view-table').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(change).not.toHaveBeenCalled()
  })
})

describe('flat compatibility and themes', () => {
  it.each([false, true])(
    'preserves ungrouped options, order and selection (compact=%s)',
    async (compact) => {
      render(
        <Harness
          compact={compact}
          options={options.map(({ id, label, testId }) => ({
            id,
            label,
            testId,
          }))}
        />,
      )
      if (compact) {
        const select = byId(
          'collaboration-project-view-select',
        ) as HTMLSelectElement
        expect([...select.options].map((option) => option.textContent)).toEqual(
          ids.map((id) => names[id]),
        )
        await act(async () => {
          select.value = 'files'
          select.dispatchEvent(new Event('change', { bubbles: true }))
        })
      } else {
        expect(
          [...container.querySelectorAll('button')].map(
            (node) => node.textContent,
          ),
        ).toEqual(ids.map((id) => names[id]))
        await click('view-files')
      }
      expect(change).toHaveBeenLastCalledWith('files')
    },
  )

  it('preserves every entry when metadata is only partially supplied', () => {
    render(
      <Harness
        options={options.map((option) =>
          option.id === 'table' ? { ...option, group: undefined } : option,
        )}
      />,
    )
    expect(container.querySelectorAll('button')).toHaveLength(7)
    expect(
      container.querySelector('[data-testid="project-view-switcher"]'),
    ).toBeNull()
  })

  it.each(ids)(
    'shares the same structure and allowed copy across both themes for %s',
    (view) => {
      let lightStructure = ''
      for (const theme of ['light', 'dark'] as const) {
        render(
          <CollaborationTheme mode={theme}>
            <Harness key={`${theme}:${view}`} value={view} />
          </CollaborationTheme>,
        )
        const nav = byId('project-view-switcher')
        expect(nav.textContent).not.toMatch(
          /surface|mode|resolver|legacyView|lossy/,
        )
        expect(
          [...nav.querySelectorAll('[aria-label]')]
            .map((node) => node.getAttribute('aria-label'))
            .join(' '),
        ).not.toMatch(/surface|mode|resolver|legacyView|lossy/)
        if (theme === 'light') lightStructure = nav.innerHTML
        else expect(nav.innerHTML).toBe(lightStructure)
      }
    },
  )

  it('localizes group and timeline labels without changing caller-provided labels', () => {
    render(<Harness locale="en" value="gantt" />)
    expect(tabLabels('.project-view-switcher-primary')).toEqual([
      'Work',
      'Plan',
      'Manage',
    ])
    expect(tabLabels('.project-view-switcher-tabs')[0]).toBe('Timeline')
  })
})
