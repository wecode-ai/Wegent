import engineeringRenderers from '@file-viewer/preset-engineering'
import textRenderers from '@file-viewer/preset-lite'
import FileViewer from '@file-viewer/react'
import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import mermaid from 'mermaid'
import { MarkdownDiagramPreview } from '@wegent/collaboration/markdown/MarkdownDiagramPreview'
import { browserMarkdownServices, MarkdownServicesProvider } from '@wegent/collaboration/markdown'

const originalGetBBox = SVGElement.prototype.getBBox
const originalAppendChild = Node.prototype.appendChild
const measuredDocuments = new Set<Document>()

function stubGetBBox(view: (Window & typeof globalThis) | null) {
  if (!view?.SVGElement) return
  Object.defineProperty(view.SVGElement.prototype, 'getBBox', {
    configurable: true,
    value(this: SVGElement) {
      measuredDocuments.add(this.ownerDocument)
      return new DOMRect(0, 0, 100, 20)
    },
  })
}

function stubContainedIframeWindows(node: Node) {
  if (!(node instanceof Element)) return
  if (node instanceof HTMLIFrameElement) stubGetBBox(node.contentDocument?.defaultView ?? null)
  node
    .querySelectorAll('iframe')
    .forEach(iframe => stubGetBBox(iframe.contentDocument?.defaultView ?? null))
}

beforeAll(() => {
  stubGetBBox(window)
  Node.prototype.appendChild = function <T extends Node>(this: Node, node: T): T {
    const appended = originalAppendChild.call(this, node) as T
    stubContainedIframeWindows(node)
    return appended
  }
})

afterAll(() => {
  Node.prototype.appendChild = originalAppendChild
  if (originalGetBBox) {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: originalGetBBox,
    })
  } else {
    delete (SVGElement.prototype as Partial<SVGElement>).getBBox
  }
})

function sandboxedMermaidResult(svg: string): string {
  const html = `<body style="margin:0">${svg}</body>`
  const encoded = btoa(unescape(encodeURIComponent(html)))
  return `<iframe src="data:text/html;charset=UTF-8;base64,${encoded}"></iframe>`
}

function artifactSvg(image: Element) {
  const source = decodeURIComponent(image.getAttribute('src')!.split(',').slice(1).join(','))
  const parsed = new DOMParser().parseFromString(source, 'image/svg+xml')
  const error = parsed.querySelector('parsererror')
  if (error) throw new Error(`${error.textContent}\n${source.slice(-1600)}`)
  return document.importNode(parsed.querySelector('svg')!, true)
}

async function readyImages(container: HTMLElement, count = 1) {
  await waitFor(
    () => expect(container.querySelectorAll('[data-testid="diagram-image"]')).toHaveLength(count),
    { timeout: 10_000 }
  )
  const images = Array.from(
    container.querySelectorAll<HTMLImageElement>('[data-testid="diagram-image"]')
  )
  images.forEach(image => fireEvent.load(image))
  expect(container.querySelector('[data-testid="diagram-pan-canvas"] svg')).toBeNull()
  return images
}

const MULTILINE_MERMAID = `flowchart TD
    APP["开发者代码<br/>app.js / pages"]
    SDK["wbx.cloud 客户端 SDK"]
    INIT["init<br/>记录默认 env"]
    CALL["callFunction<br/>校验入参 / 解析 env / 序列化 data"]
    APP -->|init| INIT
    APP -->|callFunction| CALL
    INIT --> SDK
    linkStyle default stroke:#2166cc`

test('finishes a real Mermaid viewer in the Markdown preparation window before it enters the viewport', async () => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  let diagramTop = 1_800
  const bounds = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'assistant-diagram-preview'
        ? new DOMRect(0, diagramTop, 600, 384)
        : new DOMRect(0, 0, 600, 800)
    })
  const view = render(
    <div data-scroll-origin="bottom">
      <MarkdownDiagramPreview code={'graph LR\nPREPARED --> VISIBLE'} language="mermaid" />
    </div>
  )
  try {
    const [image] = await readyImages(view.container)
    expect(view.container.querySelector('[data-diagram-status="ready"]')).toBeInTheDocument()
    diagramTop = 160
    act(() => view.container.firstElementChild!.dispatchEvent(new Event('scroll')))
    expect(view.container.querySelector('[data-testid="diagram-image"]')).toBe(image)
  } finally {
    view.unmount()
    bounds.mockRestore()
    vi.unstubAllGlobals()
  }
}, 15_000)

test('renders Mermaid HTML labels containing line breaks', async () => {
  const { container } = render(
    <MarkdownDiagramPreview code={MULTILINE_MERMAID} language="mermaid" />
  )

  const [image] = await readyImages(container)
  const svg = artifactSvg(image)
  expect(svg).toHaveTextContent('开发者代码')
  expect(svg).toHaveTextContent('app.js / pages')
  const labels = Array.from(
    svg.getElementsByTagNameNS('http://www.w3.org/2000/svg', 'foreignObject')
  )
  expect(labels.length).toBeGreaterThan(0)
  expect(
    labels.some(
      label => label.getElementsByTagNameNS('http://www.w3.org/1999/xhtml', 'br').length > 0
    )
  ).toBe(true)
  const arrows = Array.from(svg.querySelectorAll('[marker-end]'))
  expect(arrows.length).toBeGreaterThan(0)
  for (const arrow of arrows) {
    const markerId = arrow.getAttribute('marker-end')?.match(/#([^)'"\s]+)/)?.[1]
    const marker = Array.from(svg.querySelectorAll('marker')).find(node => node.id === markerId)
    expect(marker?.querySelector('path')?.getAttribute('stroke')).toBe('#2166cc')
  }
  expect(document.querySelector('[data-file-viewer-mermaid-isolate]')).toBeNull()
}, 15_000)

test('renders a real Mermaid sequence diagram without leaving its sandbox host mounted', async () => {
  measuredDocuments.clear()
  const { container } = render(
    <MarkdownDiagramPreview
      code={
        'sequenceDiagram\n  participant User\n  participant Wework\n  User->>Wework: 加载历史\n  Wework-->>User: render messages'
      }
      language="mermaid"
    />
  )

  const [image] = await readyImages(container)
  const svg = artifactSvg(image)
  expect(svg).toHaveTextContent('加载历史')
  expect(measuredDocuments.size).toBe(1)
  expect(measuredDocuments.has(document)).toBe(false)
  expect(document.querySelector('iframe')).toBeNull()
}, 15_000)

test.each([
  ['gitGraph', 'gitGraph\n  commit id: "Initial commit"\n  branch feature\n  commit', 'feature'],
  ['eventmodeling', 'eventmodeling\n  tf 01 evt Start', 'Start'],
])(
  'renders %s with measurements in the diagram document',
  async (_kind, code, label) => {
    measuredDocuments.clear()
    const { container } = render(<MarkdownDiagramPreview code={code} language="mermaid" />)

    const [image] = await readyImages(container)
    expect(artifactSvg(image)).toHaveTextContent(label)
    expect(measuredDocuments.size).toBe(1)
    expect(measuredDocuments.has(document)).toBe(false)
    expect(document.querySelector('iframe')).toBeNull()
  },
  15_000
)

test('keeps the active Mermaid render config while other requests enter the queue', async () => {
  const conversationContainer = document.body.appendChild(document.createElement('div'))
  const fileContainer = document.body.appendChild(document.createElement('div'))
  try {
    const conversation = mermaid.render(
      'queued-conversation',
      'gitGraph\n  commit id: "Conversation"',
      conversationContainer,
      { securityLevel: 'sandbox', suppressErrorRendering: true }
    )
    const invalid = mermaid.render('queued-invalid', 'invalid Mermaid source', fileContainer, {
      securityLevel: 'strict',
      suppressErrorRendering: true,
    })
    const file = mermaid.render('queued-file', 'flowchart LR\nFile --> Finished', fileContainer, {
      securityLevel: 'strict',
    })

    const [conversationResult, invalidResult, fileResult] = await Promise.allSettled([
      conversation,
      invalid,
      file,
    ])
    expect(conversationResult).toMatchObject({
      status: 'fulfilled',
      value: { svg: expect.stringContaining('<iframe') },
    })
    expect(invalidResult.status).toBe('rejected')
    expect(fileResult).toMatchObject({
      status: 'fulfilled',
      value: { svg: expect.stringMatching(/^<svg.*File/s) },
    })
    expect(conversationContainer).toBeEmptyDOMElement()
    expect(fileContainer).toBeEmptyDOMElement()
  } finally {
    conversationContainer.remove()
    fileContainer.remove()
  }
}, 15_000)

test('renders a file preview after a conversation diagram renders during its paint wait', async () => {
  const scheduleFrame = window.requestAnimationFrame.bind(window)
  const file = new File(['flowchart LR\nFilePreview --> Finished'], 'preview.mmd')
  const options = { preset: [engineeringRenderers], theme: 'light' as const }
  let resumeFile: FrameRequestCallback | undefined
  const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    if (!resumeFile && document.querySelector('[data-file-viewer-mermaid-isolate]')) {
      resumeFile = callback
      return 0
    }
    return scheduleFrame(callback)
  })

  try {
    const viewer = render(
      <FileViewer file={file} filename={file.name} type="mermaid" options={options} />
    )
    await waitFor(() => expect(resumeFile).toBeDefined())

    const conversation = render(
      <MarkdownDiagramPreview code={'flowchart LR\nConversation --> Finished'} language="mermaid" />
    )
    const [image] = await readyImages(conversation.container)
    expect(artifactSvg(image)).toHaveTextContent('Conversation')

    frames.mockRestore()
    scheduleFrame(resumeFile!)
    await waitFor(() => {
      expect(viewer.container.querySelector('svg[data-diagram-cache-hit]')).toHaveTextContent(
        'FilePreview'
      )
    })
  } finally {
    frames.mockRestore()
  }
}, 15_000)

test('renders an embedded Markdown diagram behind a sandboxed Mermaid request', async () => {
  const renderDiagram = mermaid.render
  const conversationContainer = document.body.appendChild(document.createElement('div'))
  const file = new File(
    ['```mermaid\nflowchart LR\nMarkdownPreview --> Finished\n```'],
    'preview.md'
  )
  let conversation: ReturnType<typeof renderDiagram> | undefined
  const requests = vi
    .spyOn(mermaid, 'render')
    .mockImplementation((id, source, container, config) => {
      if (id.startsWith('file-viewer-markdown-mermaid-')) {
        conversation = renderDiagram(
          'markdown-preview-conversation',
          'gitGraph\n  commit id: "Conversation"',
          conversationContainer,
          { securityLevel: 'sandbox' }
        )
      }
      return renderDiagram(id, source, container, config)
    })

  try {
    const view = render(
      <FileViewer
        file={file}
        filename={file.name}
        type="markdown"
        options={{ preset: [textRenderers], theme: 'light' }}
      />
    )
    await waitFor(() => {
      expect(view.container.querySelector('.markdown-mermaid-svg')).toHaveTextContent(
        'MarkdownPreview'
      )
    })
    expect((await conversation)?.svg).toContain('<iframe')
  } finally {
    conversationContainer.remove()
    requests.mockRestore()
  }
}, 15_000)

test('reuses one sanitized image artifact across copies, remounts and full screen with separate theme keys', async () => {
  const renderMermaid = vi.spyOn(mermaid, 'render').mockImplementation(async id => ({
    diagramType: 'flowchart',
    svg: sandboxedMermaidResult(`<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 100" aria-labelledby="label">
      <style>#${id} #fff {fill:#fff;marker-end:url(#arrow)} #${id} #node\\:one {opacity:1}</style>
      <title id="label">Cached diagram</title>
      <defs><marker id="arrow"><path d="M0 0L10 5" /></marker></defs>
      <g id="node:one"><text>Cache label</text></g>
      <path id="fff" marker-end="url(#arrow)" d="M0 0L20 20" />
      <use href="#node:one" />
      <script>window.unsafeDiagram = true</script>
    </svg>`),
  }))
  const source = 'graph LR\nCACHE_RESULT --> CACHE_TARGET'
  const preview = (theme: 'light' | 'dark', copies: number) => (
    <MarkdownServicesProvider value={{ ...browserMarkdownServices, theme }}>
      {Array.from({ length: copies }, (_, index) => (
        <MarkdownDiagramPreview key={index} code={source} language="mermaid" />
      ))}
    </MarkdownServicesProvider>
  )
  try {
    const first = render(preview('light', 2))
    const firstImages = await readyImages(first.container, 2)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(firstImages[0].src).toBe(firstImages[1].src)
    const svg = artifactSvg(firstImages[0])
    expect(svg.querySelector('script')).toBeNull()
    expect(svg.getAttribute('aria-labelledby')).toBe(svg.querySelector('title')?.id)
    expect(svg.querySelector('use')?.getAttribute('href')).toBe('#node:one')
    expect(svg.querySelector('[marker-end]')?.getAttribute('marker-end')).toBe('url(#arrow)')
    expect(svg.querySelector('style')?.textContent).toContain('fill:#fff')
    const src = firstImages[0].src
    fireEvent.click(first.container.querySelector('[data-testid="diagram-fullscreen-button"]')!)
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="assistant-diagram-fullscreen"]'
    )!
    const [expanded] = await readyImages(dialog)
    expect(expanded.src).toBe(src)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    fireEvent.click(dialog.querySelector('[data-testid="diagram-exit-fullscreen-button"]')!)
    await readyImages(first.container, 2)
    first.unmount()

    const second = render(preview('light', 1))
    const [cached] = await readyImages(second.container)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(cached.src).toBe(src)
    second.rerender(preview('dark', 1))
    await waitFor(() => expect(renderMermaid).toHaveBeenCalledTimes(2))
    const [dark] = await readyImages(second.container)
    expect(dark.src).not.toBe(src)
    second.unmount()
  } finally {
    renderMermaid.mockRestore()
  }
}, 15_000)

test('sanitizes unsafe SVG returned by the PlantUML server', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200" onload="alert('unsafe')">
        <style>@import "https://example.com/tracker.css";</style>
        <a href="javascript:alert('unsafe')"><text>unsafe link</text></a>
        <use href="#safe-symbol" />
        <use id="unsafe-xlink" xlink:href="javascript:alert('unsafe')" />
        <image href="https://example.com/tracker.png" />
        <script>alert('unsafe')</script>
      </svg>`,
      { status: 200, headers: { 'Content-Type': 'image/svg+xml' } }
    )
  )

  try {
    const { container } = render(
      <MarkdownServicesProvider
        value={{
          ...browserMarkdownServices,
          plantumlServerUrl: 'https://plantuml.example.com/svg',
        }}
      >
        <MarkdownDiagramPreview
          code={'@startuml\nAlice -> Bob: hello\n@enduml'}
          language="plantuml"
        />
      </MarkdownServicesProvider>
    )

    const [image] = await readyImages(container)
    const svg = artifactSvg(image)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(svg.querySelector('script')).toBeNull()
    expect(svg).not.toHaveAttribute('onload')
    expect(svg.querySelector('style')).toBeNull()
    expect(svg.querySelector('a')).not.toHaveAttribute('href')
    expect(svg.querySelector('use')).toHaveAttribute('href', '#safe-symbol')
    expect(svg.querySelector('#unsafe-xlink')).not.toHaveAttribute('xlink:href')
    expect(svg.querySelector('image')).not.toHaveAttribute('href')
  } finally {
    fetchMock.mockRestore()
  }
}, 15_000)

test('recovers from compilation and image loading failures while preserving the source and cached result', async () => {
  const renderMermaid = vi
    .spyOn(mermaid, 'render')
    .mockRejectedValueOnce(new Error('Invalid diagram'))
    .mockResolvedValue({
      diagramType: 'flowchart',
      svg: sandboxedMermaidResult(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Recovered</text></svg>'
      ),
    })
  const view = render(
    <MarkdownDiagramPreview code={'graph LR\nRECOVER --> RESULT'} language="mermaid" />
  )
  try {
    await waitFor(() =>
      expect(view.container.querySelector('[role="alert"]')).toHaveTextContent('RECOVER')
    )
    expect(view.container.querySelector('[data-testid="diagram-copy-image-button"]')).toBeDisabled()
    fireEvent.click(view.container.querySelector('[data-testid="diagram-retry-button"]')!)
    const [image] = await readyImages(view.container)
    expect(renderMermaid).toHaveBeenCalledTimes(2)
    fireEvent.click(view.container.querySelector('[data-testid="diagram-fullscreen-button"]')!)
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="assistant-diagram-fullscreen"]'
    )!
    const [expanded] = await readyImages(dialog)
    expect(image.src).toBe(expanded.src)
    fireEvent.error(expanded)
    expect(dialog.querySelector('[role="alert"]')).toHaveTextContent('RECOVER')
    expect(dialog.querySelector('[data-testid="diagram-copy-image-button"]')).toBeDisabled()
    fireEvent.click(dialog.querySelector('[data-testid="diagram-exit-fullscreen-button"]')!)
    expect(document.querySelector('[data-testid="assistant-diagram-fullscreen"]')).toBeNull()
    fireEvent.click(view.container.querySelector('[data-testid="diagram-retry-button"]')!)
    await readyImages(view.container)
    expect(view.container.querySelector('[data-diagram-status="ready"]')).toBeInTheDocument()
    expect(renderMermaid).toHaveBeenCalledTimes(2)
  } finally {
    view.unmount()
    renderMermaid.mockRestore()
  }
})
