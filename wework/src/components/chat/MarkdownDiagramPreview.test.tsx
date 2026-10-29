import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { MarkdownDiagramPreview as SharedMarkdownDiagramPreview } from '@wegent/collaboration/markdown/MarkdownDiagramPreview'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import { useDesktopMarkdownServices } from './useDesktopMarkdownServices'
import {
  createMarkdownWindowingScope,
  MarkdownWindowingContext,
  MarkdownWindowingDisabledContext,
} from '../../../../packages/collaboration/src/markdown/MarkdownWindowingScope'
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

const artifactMocks = vi.hoisted(() => ({
  render: vi.fn(),
  autoReady: true,
  artifact: { svg: '<svg />', src: 'data:image/svg+xml,test', width: 100, height: 100 },
}))
const appearanceMocks = vi.hoisted(() => ({
  resolvedMode: 'light' as 'dark' | 'light',
}))
const imageExportMocks = vi.hoisted(() => ({
  copy: vi.fn(),
  render: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  save: vi.fn(),
}))

vi.mock('../../../../packages/collaboration/src/markdown/useDiagramArtifact', async () => {
  const { useEffect } = await import('react')
  return {
    useDiagramArtifact: (
      request: { code: string; kind: string; theme: string; plantumlServerUrl?: string },
      enabled: boolean
    ) => {
      const { code, kind, theme, plantumlServerUrl } = request
      useEffect(() => {
        if (enabled) artifactMocks.render({ code, kind, theme, plantumlServerUrl })
      }, [enabled, code, kind, theme, plantumlServerUrl])
      return enabled ? { status: 'ready', artifact: artifactMocks.artifact } : { status: 'loading' }
    },
  }
})
vi.mock('../../../../packages/collaboration/src/markdown/DiagramCanvas', async () => {
  const { useEffect } = await import('react')
  return {
    DiagramCanvas: ({ onReady }: { onReady: () => void }) => {
      useEffect(() => {
        if (artifactMocks.autoReady) onReady()
      }, [onReady])
      return (
        <div>
          <button data-testid="diagram-zoom-out-button">Zoom out</button>
          <img data-testid="diagram-image" onLoad={onReady} alt="Diagram" />
        </div>
      )
    },
  }
})
vi.mock('@/features/appearance', () => ({
  useOptionalAppearance: () => ({ resolvedMode: appearanceMocks.resolvedMode }),
}))
vi.mock('@wegent/collaboration/markdown/diagramImageExport', () => ({
  copyDiagramPng: imageExportMocks.copy,
  renderDiagramPng: imageExportMocks.render,
  saveDiagramPng: imageExportMocks.save,
}))

beforeEach(() => {
  artifactMocks.render.mockClear()
  artifactMocks.autoReady = true
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

test('records explicit image readiness without inspecting viewer DOM or logging source', () => {
  artifactMocks.autoReady = false
  vi.spyOn(console, 'info').mockImplementation(() => {})
  const layoutRead = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect')
  startConversationDiagnosticCapture()
  const source = 'graph LR\nA[private-diagram-label] --> B'
  const first = render(<MarkdownDiagramPreview code={source} language="mermaid" />)
  const events = () => getConversationDiagnosticsSnapshot()!.events
  const start = events().find(event => event.name === 'search-diagram-viewer-start')!
  expect(events().filter(event => event.name === 'search-diagram-viewer-result')).toHaveLength(0)
  fireEvent.load(screen.getByTestId('diagram-image'))
  expect(
    events().find(event => event.name === 'search-diagram-viewer-result')?.details
  ).toMatchObject({
    diagramRenderId: start.details.diagramRenderId,
    rendered: true,
    failed: false,
  })
  expect(layoutRead).not.toHaveBeenCalled()
  first.unmount()
  const second = render(<MarkdownDiagramPreview code={source} language="mermaid" />)
  const secondStart = events()
    .filter(event => event.name === 'search-diagram-viewer-start')
    .at(-1)!
  expect(secondStart.details.diagramContentId).toBe(start.details.diagramContentId)
  expect(secondStart.details.diagramInstanceId).not.toBe(start.details.diagramInstanceId)
  second.unmount()
  expect(JSON.stringify(getConversationDiagnosticsSnapshot())).not.toContain(
    'private-diagram-label'
  )
})

function mockDiagramViewport(initialTop: number) {
  let top = initialTop
  let height = 384
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
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.dataset.testid === 'assistant-diagram-preview'
      ? new DOMRect(0, top, 600, height)
      : new DOMRect(0, 0, 600, 800)
  })
  return {
    observations,
    move(nextTop: number, nextHeight = 384) {
      top = nextTop
      height = nextHeight
    },
    notify() {
      act(() =>
        observations[0].callback(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          {} as IntersectionObserver
        )
      )
    },
  }
}

test.each([0, 1_800, 2_400, -1_984])(
  'prepares a newly mounted diagram at %ipx before any intersection notification',
  top => {
    mockDiagramViewport(top)
    render(
      <div data-scroll-origin="bottom">
        <MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />
      </div>
    )
    expect(artifactMocks.render).toHaveBeenCalledTimes(1)
  }
)

test('search expansion keeps distant diagrams idle and scroll activation retains the viewer', () => {
  const viewport = mockDiagramViewport(4_000)
  const scrollElementRef = { current: null as HTMLDivElement | null }
  const scope = createMarkdownWindowingScope(scrollElementRef, vi.fn())
  const view = render(
    <div ref={scrollElementRef} data-scroll-origin="bottom" data-testid="diagram-scroll-viewport">
      <MarkdownWindowingContext.Provider value={scope}>
        <MarkdownWindowingDisabledContext.Provider value>
          <MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />
        </MarkdownWindowingDisabledContext.Provider>
      </MarkdownWindowingContext.Provider>
    </div>
  )
  expect(viewport.observations[0].options).toEqual({
    root: screen.getByTestId('diagram-scroll-viewport'),
    rootMargin: '1600px 0px',
  })
  expect(artifactMocks.render).not.toHaveBeenCalled()
  viewport.notify() // Ignore an entry queued before a search jump.
  expect(artifactMocks.render).not.toHaveBeenCalled()
  viewport.move(160, 0)
  viewport.notify()
  expect(artifactMocks.render).not.toHaveBeenCalled()
  viewport.move(1_800)
  act(() => scope.getViewportRenders().forEach(render => render()))
  const viewer = screen.getByTestId('diagram-image')
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
  expect(viewport.observations[0].disconnect).toHaveBeenCalled()
  expect(
    screen.getByTestId('assistant-diagram-preview').querySelector('[data-diagram-search-source]')
  ).toHaveAttribute('hidden')
  viewport.move(4_000)
  viewport.notify()
  viewport.move(160)
  viewport.notify()
  expect(screen.getByTestId('diagram-image')).toBe(viewer)
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
  view.unmount()
  viewport.notify()
  expect(scope.getViewportRenders()).toEqual([])
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
})

test('prepares diagrams on standalone scrolling and ignores callbacks after cleanup', () => {
  const viewport = mockDiagramViewport(4_000)
  const view = render(
    <div data-scroll-origin="bottom" data-testid="diagram-scroll-viewport">
      <MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />
    </div>
  )
  viewport.move(1_800)
  act(() => screen.getByTestId('diagram-scroll-viewport').dispatchEvent(new Event('scroll')))
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
  view.unmount()
  viewport.move(4_000)
  const distant = render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)
  const observation = viewport.observations.at(-1)!
  distant.unmount()
  act(() =>
    observation.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  )
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
})

test('refreshes a stale intersection after a layout jump without waiting for scrolling', () => {
  let refresh!: FrameRequestCallback
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    refresh = callback
    return 1
  })
  const cancel = vi.spyOn(window, 'cancelAnimationFrame')
  const viewport = mockDiagramViewport(4_000)
  const view = render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)
  const observation = viewport.observations[0]
  viewport.notify()
  expect(artifactMocks.render).not.toHaveBeenCalled()
  viewport.move(160)
  act(() => refresh(performance.now()))
  expect(observation.unobserve).toHaveBeenCalled()
  expect(observation.observe).toHaveBeenCalledTimes(2)
  viewport.notify()
  expect(artifactMocks.render).toHaveBeenCalledTimes(1)
  view.unmount()

  viewport.move(4_000)
  const pending = render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)
  const pendingObservation = viewport.observations.at(-1)!
  act(() =>
    pendingObservation.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  )
  pending.unmount()
  expect(cancel).toHaveBeenCalledWith(1)
  act(() => refresh(performance.now()))
  expect(pendingObservation.observe).toHaveBeenCalledTimes(1)
})

test('requests PlantUML with its configured server', () => {
  render(<MarkdownDiagramPreview code={'@startuml\nAlice -> Bob\n@enduml'} language="plantuml" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'plantuml'
  )
  expect(artifactMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'plantuml',
      plantumlServerUrl: 'https://www.plantuml.com/plantuml/svg',
    })
  )
})

test('normalizes mmd fences to the Mermaid drawing renderer', () => {
  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mmd" />)

  expect(screen.getByTestId('assistant-diagram-preview')).toHaveAttribute(
    'data-language',
    'mermaid'
  )
  expect(artifactMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'mermaid',
    })
  )
})

test('uses the current Wework dark theme', () => {
  appearanceMocks.resolvedMode = 'dark'

  render(<MarkdownDiagramPreview code={'graph LR\nA --> B'} language="mermaid" />)

  expect(artifactMocks.render).toHaveBeenCalledWith(
    expect.objectContaining({
      theme: 'dark',
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
  const exitButton = screen.getByTestId('diagram-exit-fullscreen-button')
  await waitFor(() => expect(exitButton).toHaveFocus())

  await user.tab()
  expect(screen.getByTestId('diagram-zoom-out-button')).toHaveFocus()
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
