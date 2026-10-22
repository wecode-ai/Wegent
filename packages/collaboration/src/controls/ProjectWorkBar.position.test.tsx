// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createCollaborationTranslator } from '../i18n'
import { ProjectWorkBar, type ProjectWorkBarProps } from './ProjectWorkBar'

describe('project chooser positioning', () => {
  let root: Root
  let container: HTMLDivElement

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.stubGlobal('innerHeight', 800)
    vi.stubGlobal('innerWidth', 1200)
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
    return vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(120, top, 160, 32))
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

    expect(menu.parentElement).toBe(document.body)
    expect(menu.style.bottom).toBe('108px')
    expect(menu.style.top).toBe('')
    expect(menu.style.maxHeight).toBe('480px')
  })

  test('keeps the lower edge attached when content changes, the window resizes, or the anchor scrolls', () => {
    render()
    const anchorRect = positionComposerAnchor(700)
    const menu = openMenu()

    render({ projects: [] })
    expect(menu.style.bottom).toBe('108px')
    expect(menu.style.top).toBe('')

    vi.stubGlobal('innerHeight', 600)
    anchorRect.mockReturnValue(new DOMRect(120, 500, 160, 32))
    act(() => window.dispatchEvent(new Event('resize')))
    expect(menu.style.bottom).toBe('108px')
    expect(menu.style.maxHeight).toBe('476px')

    anchorRect.mockReturnValue(new DOMRect(120, 560, 160, 32))
    act(() => window.dispatchEvent(new Event('scroll')))
    expect(menu.style.bottom).toBe('48px')
  })

  test('anchors the upper edge when opening below the composer', () => {
    render()
    positionComposerAnchor(100)

    const menu = openMenu()

    expect(menu.style.top).toBe('140px')
    expect(menu.style.bottom).toBe('')
  })

  test.each([
    { top: 180, expectedTop: '220px', expectedBottom: '' },
    { top: 700, expectedTop: '', expectedBottom: '108px' },
  ])('attaches to the external title anchor at $top', ({ top, expectedTop, expectedBottom }) => {
    const titleAnchor = document.createElement('button')
    vi.spyOn(titleAnchor, 'getBoundingClientRect').mockReturnValue(new DOMRect(400, top, 120, 32))
    const props = {
      projectMenuAnchorElement: titleAnchor,
      projectMenuOpenSignal: 0,
    }
    render(props)
    render({ ...props, projectMenuOpenSignal: 1 })

    const menu = element('project-work-menu')

    expect(menu.style.left).toBe('300px')
    expect(menu.style.top).toBe(expectedTop)
    expect(menu.style.bottom).toBe(expectedBottom)
  })
})
