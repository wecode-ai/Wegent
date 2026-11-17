import { act, fireEvent, render, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
import mermaid from 'mermaid'
import { MarkdownDiagramPreview } from '@wegent/collaboration/markdown/MarkdownDiagramPreview'
import { browserMarkdownServices, MarkdownServicesProvider } from '@wegent/collaboration/markdown'

const originalGetBBox = SVGElement.prototype.getBBox

beforeAll(() => {
  Object.defineProperty(SVGElement.prototype, 'getBBox', {
    configurable: true,
    value: () => new DOMRect(0, 0, 100, 20),
  })
})

afterAll(() => {
  if (originalGetBBox) {
    Object.defineProperty(SVGElement.prototype, 'getBBox', {
      configurable: true,
      value: originalGetBBox,
    })
  } else {
    delete (SVGElement.prototype as Partial<SVGElement>).getBBox
  }
})

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
  expect(svg).toHaveAttribute('data-mermaid-layout-isolated', 'true')
  const arrows = Array.from(svg.querySelectorAll('[marker-end]'))
  expect(arrows.length).toBeGreaterThan(0)
  for (const arrow of arrows) {
    const markerId = arrow.getAttribute('marker-end')?.match(/#([^)'"\s]+)/)?.[1]
    const marker = Array.from(svg.querySelectorAll('marker')).find(node => node.id === markerId)
    expect(marker?.querySelector('path')?.getAttribute('stroke')).toBe('#2166cc')
  }
  expect(document.querySelector('[data-file-viewer-mermaid-isolate]')).toBeNull()
}, 15_000)

test('reuses one sanitized image artifact across copies, remounts and full screen with separate theme keys', async () => {
  const renderMermaid = vi.spyOn(mermaid, 'render').mockImplementation(async id => ({
    diagramType: 'flowchart',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" viewBox="0 0 100 100" aria-labelledby="label">
      <style>#${id} #fff {fill:#fff;marker-end:url(#arrow)} #${id} #node\\:one {opacity:1}</style>
      <title id="label">Cached diagram</title>
      <defs><marker id="arrow"><path d="M0 0L10 5" /></marker></defs>
      <g id="node:one"><text>Cache label</text></g>
      <path id="fff" marker-end="url(#arrow)" d="M0 0L20 20" />
      <use href="#node:one" />
      <script>window.unsafeDiagram = true</script>
    </svg>`,
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
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><text>Recovered</text></svg>',
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
