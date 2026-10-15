import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { MarkdownDiagramPreview as SharedMarkdownDiagramPreview } from '@wegent/collaboration/markdown/MarkdownDiagramPreview'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
import { MarkdownWindowingDisabledContext } from '../../../../packages/collaboration/src/markdown/MarkdownWindowingScope'
import {
  getConversationDiagnosticsSnapshot,
  resetConversationDiagnosticsForTest,
  startConversationDiagnosticCapture,
} from '../../../../packages/collaboration/src/conversation/conversationDiagnostics'

function MarkdownDiagramPreview(props: ComponentProps<typeof SharedMarkdownDiagramPreview>) {
  return (
    <MarkdownServicesProvider value={useDesktopMarkdownServices()}>
      <SharedMarkdownDiagramPreview {...props} />
    </MarkdownServicesProvider>
  )
}

const fileViewerMocks = vi.hoisted(() => ({
  render: vi.fn(),
}))
const appearanceMocks = vi.hoisted(() => ({
  resolvedMode: 'light' as 'dark' | 'light',
}))
const imageExportMocks = vi.hoisted(() => ({
  copy: vi.fn(),
  render: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  save: vi.fn(),
}))

vi.mock('@file-viewer/react', () => ({
  default: (props: Record<string, unknown>) => {
    fileViewerMocks.render(props)
    return (
      <div data-testid="file-viewer">
        <svg className="drawing-diagram-svg" />
      </div>
    )
  },
}))

vi.mock('@file-viewer/preset-engineering', () => ({ default: {} }))
vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => ({ resolvedMode: appearanceMocks.resolvedMode }),
}))
vi.mock('@wegent/collaboration/markdown/diagramImageExport', () => ({
  copyDiagramPng: imageExportMocks.copy,
  renderDiagramPng: imageExportMocks.render,
  saveDiagramPng: imageExportMocks.save,
}))

beforeEach(() => {
  fileViewerMocks.render.mockClear()
  appearanceMocks.resolvedMode = 'light'
  imageExportMocks.copy.mockClear()
  imageExportMocks.render.mockClear()
  imageExportMocks.save.mockClear()
})

afterEach(() => {
  resetConversationDiagnosticsForTest()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('correlates diagram remounts and waits for final SVG readiness without diagnostic layout reads', async () => {
  resetConversationDiagnosticsForTest()
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const layoutRead = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  startConversationDiagnosticCapture()
  const source = 'graph LR\nA[private-diagram-label] --> B'
  const first = render(<MarkdownDiagramPreview code={source} language="mermaid" />)
  const events = () => getConversationDiagnosticsSnapshot()!.events
  const firstStart = events().find(event => event.name === 'search-diagram-viewer-start')!
  expect(firstStart.details.diagramContentId).toEqual(expect.any(Number))
  expect(firstStart.details.diagramInstanceId).toEqual(expect.any(Number))
  expect(events().filter(event => event.name === 'search-diagram-viewer-result')).toHaveLength(0)
  const viewer = screen.getByTestId('file-viewer')
  const svg = viewer.querySelector('svg')!
  const pan = document.createElement('div')
  pan.className = 'drawing-diagram-pan'
  const state = document.createElement('div')
  state.className = 'drawing-state'
  await act(async () => {
    pan.append(svg)
    viewer.append(pan, state)
    await Promise.resolve()
  })
  // The final SVG alone is not ready while Panzoom initialization is pending.
  expect(events().filter(event => event.name === 'search-diagram-viewer-result')).toHaveLength(0)
  await act(async () => {
    state.hidden = true
    await Promise.resolve()
  })
  const result = events().find(event => event.name === 'search-diagram-viewer-result')!
  expect(result.details).toMatchObject({
    diagramContentId: firstStart.details.diagramContentId,
    diagramInstanceId: firstStart.details.diagramInstanceId,
    diagramRenderId: firstStart.details.diagramRenderId,
    rendered: true,
    failed: false,
  })
  first.rerender(<MarkdownDiagramPreview code={`${source}\nB --> C`} language="mermaid" />)
  const updatedStart = events()
    .filter(event => event.name === 'search-diagram-viewer-start')
    .at(-1)!
  expect(updatedStart.details.diagramRenderId).not.toBe(firstStart.details.diagramRenderId)
  expect(events().filter(event => event.name === 'search-diagram-viewer-result')).toHaveLength(1)
  // A previous ready SVG must not finish a newly committed viewer cycle.
  await act(async () => {
    const nextState = document.createElement('div')
    nextState.className = 'drawing-state'
    nextState.hidden = true
    state.replaceWith(nextState)
    await Promise.resolve()
  })
  expect(
    events()
      .filter(event => event.name === 'search-diagram-viewer-result')
      .at(-1)?.details.diagramRenderId
  ).toBe(updatedStart.details.diagramRenderId)
  expect(layoutRead).not.toHaveBeenCalled()
  first.unmount()
  expect(
    events().find(event => event.name === 'search-diagram-viewer-stop')?.details.rendered
  ).toBe(true)
  const second = render(<MarkdownDiagramPreview code={source} language="mermaid" />)
  const secondStart = events()
    .filter(event => event.name === 'search-diagram-viewer-start')
    .at(-1)!
  expect(secondStart.details.diagramContentId).toBe(firstStart.details.diagramContentId)
  expect(secondStart.details.diagramInstanceId).not.toBe(firstStart.details.diagramInstanceId)
  expect(secondStart.details.diagramRenderId).not.toBe(firstStart.details.diagramRenderId)
  second.unmount()
  expect(
    events()
      .filter(event => event.name === 'search-diagram-viewer-stop')
      .at(-1)?.details.rendered
  ).toBe(false)
  const third = render(<MarkdownDiagramPreview code={'graph LR\nX --> Y'} language="mermaid" />)
  expect(
    events()
      .filter(event => event.name === 'search-diagram-viewer-start')
      .at(-1)?.details.diagramContentId
  ).not.toBe(firstStart.details.diagramContentId)
  third.unmount()
  expect(JSON.stringify(getConversationDiagnosticsSnapshot())).not.toContain(
    'private-diagram-label'
  )
})

test('search expansion does not start offscreen diagrams, and visibility never remounts a viewer', () => {
  let nextFrameId = 1
  const frames = new Map<number, FrameRequestCallback>()
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    const id = nextFrameId++
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => {
    frames.delete(id)
  })
  const frame = () => {
    const pending = [...frames.values()]
    frames.clear()
    act(() => pending.forEach(callback => callback(performance.now())))
  }
  const observations: Array<{
    callback: IntersectionObserverCallback
    options?: IntersectionObserverInit
    disconnect: ReturnType<typeof vi.fn>
    observe: ReturnType<typeof vi.fn>
    unobserve: ReturnType<typeof vi.fn>
  }> = []
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observations.push({
          callback,
          options,
          disconnect: this.disconnect,
          observe: this.observe,
          unobserve: this.unobserve,
        })
      }
    }
  )
  let diagramTop = 4_000
  let diagramHeight = 384
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'assistant-diagram-preview'
      ? new DOMRect(0, diagramTop, 600, diagramHeight)
      : new DOMRect(0, 0, 600, 800)
  })
  const { unmount } = render(
    <div data-scroll-origin="bottom" data-testid="diagram-scroll-viewport">
      <MarkdownWindowingDisabledContext.Provider value>
        <MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />
      </MarkdownWindowingDisabledContext.Provider>
    </div>
  )
  expect(observations).toHaveLength(1)
  const observation = observations[0]
  expect(observation.options).toEqual({
    root: screen.getByTestId('diagram-scroll-viewport'),
    rootMargin: '0px',
  })
  const notify = (isIntersecting: boolean) =>
    act(() => {
      observation.callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver
      )
    })
  expect(screen.getByTestId('assistant-diagram-preview')).toHaveClass('h-96')
  expect(
    screen.getByTestId('assistant-diagram-preview').querySelector('[data-diagram-search-source]')
  ).toHaveAttribute('hidden')
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
  notify(false)
  expect(frames.size).toBe(0)
  diagramTop = 160
  diagramHeight = 0
  notify(true)
  expect(frames.size).toBe(0)
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
  diagramTop = 4_000
  diagramHeight = 384
  notify(true) // A stale entry from before a search jump must not start rendering.
  notify(true)
  expect(frames.size).toBe(1)
  expect(fileViewerMocks.render).not.toHaveBeenCalled()
  diagramTop = 160
  frame()
  expect(observation.unobserve).toHaveBeenCalledWith(
    screen.getByTestId('assistant-diagram-preview')
  )
  expect(observation.observe).toHaveBeenCalledTimes(2)
  // Re-observing delivers a fresh entry even if the intersection threshold did not change.
  notify(true)
  const viewer = screen.getByTestId('file-viewer')
  expect(
    screen.getByTestId('assistant-diagram-preview').querySelector('[data-diagram-search-source]')
  ).toHaveAttribute('hidden')
  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
  expect(observation.disconnect).toHaveBeenCalled()
  diagramTop = 4_000
  notify(false)
  notify(true)
  expect(screen.getByTestId('file-viewer')).toBe(viewer)
  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
  unmount()
  notify(true)
  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)

  const pending = render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)
  const pendingObservation = observations[1]
  act(() => {
    pendingObservation.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  })
  const pendingFrames = [...frames.values()]
  expect(pendingFrames).toHaveLength(1)
  pending.unmount()
  expect(frames.size).toBe(0)
  // A frame already dispatched by the browser must also respect cleanup.
  act(() => pendingFrames.forEach(callback => callback(performance.now())))
  expect(pendingObservation.observe).toHaveBeenCalledTimes(1)
  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
})

test.each([
  ['bottom', 0, window.innerHeight],
  ['top', 0, -384],
  ['right', window.innerWidth, 0],
  ['left', -600, 0],
])('activates a diagram touching the %s viewport edge without re-observing', (_, left, top) => {
  let notify!: IntersectionObserverCallback
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      unobserve = vi.fn()
      constructor(callback: IntersectionObserverCallback) {
        notify = callback
      }
    }
  )
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(Number(left), Number(top), 600, 384)
  )
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  act(() => {
    notify([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
  })

  expect(fileViewerMocks.render).toHaveBeenCalledTimes(1)
  expect(requestFrame).not.toHaveBeenCalled()
})

test('renders PlantUML source through the drawing file viewer', () => {
  render(<MarkdownDiagramPreview code={'@startuml\nAlice -> Bob\n@enduml'} language="plantuml" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'plantuml'
  )
  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: 'diagram.plantuml',
      type: 'plantuml',
      options: expect.objectContaining({
        drawing: {
          plantumlServerUrl: 'https://www.plantuml.com/plantuml/svg',
        },
      }),
    })
  )
})

test('normalizes mmd fences to the Mermaid drawing renderer', () => {
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mmd" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'mermaid'
  )
  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: 'diagram.mermaid',
      type: 'mermaid',
    })
  )
})

test('uses the current Wework dark theme', () => {
  appearanceMocks.resolvedMode = 'dark'

  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  expect(fileViewerMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        theme: 'dark',
      }),
    })
  )
})

test('copies and saves the rendered diagram as a PNG', async () => {
  const user = userEvent.setup()
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  await user.click(screen.getByTestId('diagram-copy-image-button'))
  await waitFor(() => {
    expect(imageExportMocks.copy).toHaveBeenCalledWith(expect.any(Blob))
  })

  await user.click(screen.getByTestId('diagram-save-image-button'))
  await waitFor(() => {
    expect(imageExportMocks.save).toHaveBeenCalledWith(expect.any(Blob), 'mermaid-diagram.png')
  })
})

test('traps focus in the full screen diagram and restores it after Escape', async () => {
  const user = userEvent.setup()
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  const trigger = screen.getByTestId('diagram-fullscreen-button')
  expect(trigger).toHaveClass('h-11', 'w-11', 'md:h-7', 'md:w-7')
  await user.click(trigger)

  expect(screen.getByTestId('assistant-diagram-fullscreen')).toBeInTheDocument()
  const copyButton = screen.getByTestId('diagram-copy-image-button')
  const exitButton = screen.getByTestId('diagram-exit-fullscreen-button')
  await waitFor(() => expect(exitButton).toHaveFocus())

  await user.tab()
  expect(copyButton).toHaveFocus()
  await user.tab({ shift: true })
  expect(exitButton).toHaveFocus()

  await user.keyboard('{Escape}')

  expect(screen.queryByTestId('assistant-diagram-fullscreen')).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByTestId('diagram-fullscreen-button')).toHaveFocus())
})

test('exits the diagram full screen from the collapse action', async () => {
  const user = userEvent.setup()
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  await user.click(screen.getByTestId('diagram-fullscreen-button'))
  await user.click(screen.getByTestId('diagram-exit-fullscreen-button'))

  expect(screen.queryByTestId('assistant-diagram-fullscreen')).not.toBeInTheDocument()
})
