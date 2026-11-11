// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { groupedProjectViewMetadata } from '../workspace-header/ProjectViewSwitcher'
import {
  CollaborationProjectViewShell,
  buildCollaborationProjectViewOptions,
  type CollaborationProjectViewShellProps,
  type CollaborationProjectViewExtension,
} from './CollaborationProjectViewShell'

const extensions: CollaborationProjectViewExtension[] = [
  {
    id: 'calendar',
    label: '日历',
    testId: 'calendar',
    content: 'calendar-content',
  },
  { id: 'gantt', label: '甘特', testId: 'gantt', content: 'gantt-content' },
  {
    id: 'milestones',
    label: '里程碑',
    testId: 'milestones',
    content: 'milestones-content',
    after: 'table',
  },
]
const props: CollaborationProjectViewShellProps = {
  project: { access_role: 'Owner' },
  view: 'board',
  labels: { board: '看板', table: '表格', files: '文件', manage: '项目设置' },
  testIds: { board: 'board', table: 'table', files: 'files', manage: 'manage' },
  slots: {
    board: 'board-content',
    table: 'table-content',
    files: 'files-content',
    manage: 'manage-content',
  },
  extensions,
  viewMetadata: groupedProjectViewMetadata,
  assistantOpen: false,
  embedded: true,
  hasCreateAction: false,
  sidebarCollapsed: false,
  title: 'Project',
  titleIcon: null,
  renderRightActions: () => null,
  onViewChange: vi.fn(),
}

let root: Root
let container: HTMLDivElement
let width = 900
let resize: () => void

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe() {}
      disconnect() {}
    },
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    function (this: HTMLElement) {
      return this.dataset.testid === 'cloud-project-header' ? width : 0
    },
  )
  width = 900
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function render(overrides: Partial<CollaborationProjectViewShellProps> = {}) {
  act(() =>
    root.render(<CollaborationProjectViewShell {...props} {...overrides} />),
  )
}

describe('grouped project shell', () => {
  it.each(['grouped', 'partial', 'ungrouped'] as const)(
    'retains available extensions without their ordering anchor (%s)',
    (metadataKind) => {
      const viewMetadata =
        metadataKind === 'grouped'
          ? groupedProjectViewMetadata
          : metadataKind === 'partial'
            ? { board: groupedProjectViewMetadata.board }
            : undefined
      const options = buildCollaborationProjectViewOptions({
        project: props.project,
        labels: props.labels,
        testIds: props.testIds,
        enabledStandardViews: ['board', 'files', 'manage'],
        extensions,
        viewMetadata,
      })
      expect(options.map((option) => option.id)).toEqual([
        'board',
        'calendar',
        'gantt',
        'files',
        'manage',
        'milestones',
      ])
      render({
        view: 'milestones',
        enabledStandardViews: ['board', 'files', 'manage'],
        viewMetadata,
      })
      expect(
        container
          .querySelector('[data-testid="milestones"]')
          ?.getAttribute(
            metadataKind === 'grouped' ? 'aria-selected' : 'aria-current',
          ),
      ).toBe(metadataKind === 'grouped' ? 'true' : 'page')
      expect(container.textContent).toContain('milestones-content')
    },
  )
  it('derives groups from metadata and keeps navigation outside the fixed-height header', () => {
    render({ view: 'calendar' })
    expect(container.textContent).toContain('calendar-content')
    const header = container.querySelector(
      '[data-testid="cloud-project-header"]',
    )!
    const navigation = container.querySelector(
      '[data-testid="project-shell-view-navigation"]',
    )!
    expect(header.contains(navigation)).toBe(false)
    expect(header.nextElementSibling).toBe(navigation)
    expect(
      navigation.querySelectorAll(
        '.project-view-switcher-primary [role="tab"]',
      ),
    ).toHaveLength(3)
    render({ view: 'board' })
    expect(
      navigation.querySelector(
        '[data-testid="collaboration-project-secondary"]',
      ),
    ).toBeNull()
    expect(container.textContent).toContain('board-content')
  })

  it.each([
    {
      view: 'manage',
      enabledStandardViews: ['board', 'table', 'files'],
      expected: 'files',
      content: 'files-content',
    },
    {
      view: 'calendar',
      extensions: extensions.filter((option) => option.id !== 'calendar'),
      expected: 'gantt',
      content: 'gantt-content',
    },
    {
      view: 'milestones',
      extensions: extensions.filter((option) => option.id !== 'milestones'),
      expected: 'gantt',
      content: 'gantt-content',
    },
    {
      view: 'manage',
      project: { access_role: 'RestrictedAnalyst' },
      expected: 'board',
      content: 'board-content',
    },
  ] as const)(
    'resolves unavailable $view to $expected without changing the host URL',
    (scenario) => {
      const onViewChange = vi.fn()
      const onUnavailableView = vi.fn()
      const { expected, content, ...overrides } = scenario
      render({
        ...overrides,
        extensions:
          'extensions' in overrides ? [...overrides.extensions] : extensions,
        onViewChange,
        onUnavailableView,
      })
      expect(container.textContent).toContain(content)
      expect(onViewChange).not.toHaveBeenCalled()
      expect(onUnavailableView).toHaveBeenCalledWith({
        view: expected,
        content,
        viewChanged: true,
      })
      if (expected === 'board') {
        expect(
          container.querySelector('[data-testid="collaboration-tab-admin"]'),
        ).toBeNull()
        expect(container.textContent).not.toContain('manage-content')
        expect(container.textContent).not.toContain('files-content')
      }
    },
  )

  it('filters unsupported capabilities while retaining a supported empty view', () => {
    render({
      view: 'gantt',
      extensions: extensions.map((option) =>
        option.id === 'milestones' ? { ...option, available: false } : option,
      ),
    })
    expect(container.querySelector('[data-testid="milestones"]')).toBeNull()
    render({
      view: 'milestones',
      extensions: extensions.map((option) =>
        option.id === 'milestones'
          ? { ...option, content: 'empty-milestones' }
          : option,
      ),
    })
    expect(
      container
        .querySelector('[data-testid="milestones"]')
        ?.getAttribute('aria-selected'),
    ).toBe('true')
    expect(container.textContent).toContain('empty-milestones')
  })

  it('switches at 720px and responds to a resized project container', () => {
    width = 720
    render({ view: 'gantt' })
    expect(
      container.querySelector('.project-view-switcher-tabs'),
    ).not.toBeNull()
    width = 719
    act(() => resize())
    expect(container.querySelector('.project-view-switcher-tabs')).toBeNull()
    expect(
      container.querySelector('[data-testid="collaboration-compact-trigger"]'),
    ).not.toBeNull()
    expect(container.querySelector('[data-testid="calendar"]')).not.toBeNull()
    width = 720
    act(() => resize())
    expect(
      container.querySelector('.project-view-switcher-tabs'),
    ).not.toBeNull()
  })

  it('preserves flat order, placement and host state correction without metadata', () => {
    const onViewChange = vi.fn()
    render({
      viewMetadata: undefined,
      view: 'manage',
      project: { access_role: 'RestrictedAnalyst' },
      onViewChange,
    })
    expect(onViewChange).toHaveBeenCalledWith('board')
    expect(
      container.querySelector('[data-testid="project-shell-view-navigation"]'),
    ).toBeNull()
    render({ viewMetadata: undefined })
    const header = container.querySelector(
      '[data-testid="cloud-project-header"]',
    )!
    expect(
      [...header.querySelectorAll('nav button')].map(
        (button) => button.textContent,
      ),
    ).toEqual(['看板', '日历', '甘特', '表格', '里程碑', '文件', '项目设置'])
  })
})
