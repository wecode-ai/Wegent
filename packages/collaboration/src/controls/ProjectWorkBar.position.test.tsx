// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import { ProjectWorkBar, type ProjectWorkBarProps } from './ProjectWorkBar'

describe('project chooser positioning', () => {
  let root: Root
  let container: HTMLDivElement
  let anchorRects: WeakMap<Element, DOMRect>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('innerHeight', 800)
    vi.stubGlobal('innerWidth', 1200)
    vi.spyOn(document.documentElement, 'clientHeight', 'get').mockImplementation(
      () => window.innerHeight
    )
    vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(
      () => window.innerWidth
    )
    // jsdom has no layout; popup movement ignores elements with no client rects.
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function () {
      const rect = this.getBoundingClientRect()
      return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) })
    })
    anchorRects = new WeakMap()
    const original = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return (
        anchorRects.get(this) ??
        (this.dataset.testid === 'project-work-menu'
          ? new DOMRect(0, 0, 320, 260)
          : original.call(this))
      )
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function () {
      return this.dataset.testid === 'project-work-menu' ? 320 : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function () {
      return this.dataset.testid === 'project-work-menu' ? 260 : 0
    })
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

  function element(testId: string) {
    const found = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    if (!found) throw new Error(`Missing ${testId}`)
    return found
  }

  function render(overrides: Partial<ProjectWorkBarProps> = {}) {
    act(() =>
      root.render(
        <ProjectWorkBar
          translate={createCollaborationTranslator('zh-CN')}
          isMobile={false}
          projects={[{ id: 1, name: 'Wegent', tasks: [] }]}
          devices={[]}
          onSelectProject={vi.fn()}
          onSelectStandaloneDevice={vi.fn()}
          {...overrides}
        />
      )
    )
  }

  function positionComposerAnchor(top: number) {
    const anchor = element('project-work-bar').firstElementChild
    if (!anchor) throw new Error('Missing project selector anchor')
    anchorRects.set(anchor, new DOMRect(120, top, 160, 32))
    return { mockReturnValue: (rect: DOMRect) => anchorRects.set(anchor, rect) }
  }

  function openMenu() {
    act(() => element('project-work-button').click())
    return element('project-work-menu')
  }

  test.each([1, 4, 10])('anchors the lower edge above the composer with %i projects', count => {
    render({
      projects: Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        name: `Project ${index + 1}`,
        tasks: [],
      })),
    })
    positionComposerAnchor(700)

    const menu = openMenu()

    expect(menu.getAttribute('popover')).toBe('manual')
    expect(menu.dataset.side).toBe('top')
    expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(692)
    expect(menu.style.maxHeight).toBe('min(480px, var(--available-height))')
  })

  test('keeps the lower edge attached when content changes, the window resizes, or the anchor scrolls', async () => {
    render()
    const anchorRect = positionComposerAnchor(700)
    const menu = openMenu()

    render({ projects: [] })
    expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(692)

    vi.stubGlobal('innerHeight', 600)
    anchorRect.mockReturnValue(new DOMRect(120, 500, 160, 32))
    act(() => window.dispatchEvent(new Event('resize')))
    await vi.waitFor(() =>
      expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(492)
    )
    expect(menu.style.getPropertyValue('--available-height')).toBe('476px')

    anchorRect.mockReturnValue(new DOMRect(120, 560, 160, 32))
    act(() => window.dispatchEvent(new Event('scroll')))
    await vi.waitFor(() =>
      expect(Number.parseFloat(menu.style.top) + menu.getBoundingClientRect().height).toBe(552)
    )
  })

  test('anchors the upper edge when opening below the composer', () => {
    render()
    positionComposerAnchor(100)

    const menu = openMenu()

    expect(menu.style.top).toBe('140px')
    expect(menu.style.bottom).toBe('')
  })

  test.each([
    { top: 180, expectedSide: 'bottom', expectedEdge: 220 },
    { top: 700, expectedSide: 'top', expectedEdge: 692 },
  ])('attaches to the external title anchor at $top', ({ top, expectedSide, expectedEdge }) => {
    const titleAnchor = document.createElement('button')
    anchorRects.set(titleAnchor, new DOMRect(400, top, 120, 32))
    const props = {
      projectMenuAnchorElement: titleAnchor,
      projectMenuOpenSignal: 0,
    }
    render(props)
    render({ ...props, projectMenuOpenSignal: 1 })

    const menu = element('project-work-menu')

    expect(menu.style.left).toBe('300px')
    expect(menu.dataset.side).toBe(expectedSide)
    expect(
      Number.parseFloat(menu.style.top) +
        (expectedSide === 'top' ? menu.getBoundingClientRect().height : 0)
    ).toBe(expectedEdge)
  })
  test('consumes each opening signal once and accepts later signals independently', () => {
    const close = () =>
      act(() =>
        element('project-search-input').dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          })
        )
      )
    render({ projectMenuOpenSignal: 1 })
    expect(element('project-search-input')).toBe(document.activeElement)
    close()
    render({ projectMenuOpenSignal: 1 })
    expect(document.querySelector('[data-testid="project-work-menu"]')).toBeNull()
    render({ projectMenuOpenSignal: 1, externalMenuOpenSignal: 1 })
    expect(element('project-search-input')).toBe(document.activeElement)
    close()
    render({ projectMenuOpenSignal: 1, externalMenuOpenSignal: 1 })
    expect(document.querySelector('[data-testid="project-work-menu"]')).toBeNull()
    render({ projectMenuOpenSignal: 2, externalMenuOpenSignal: 1 })
    expect(element('project-work-menu')).not.toBeNull()
  })
})
