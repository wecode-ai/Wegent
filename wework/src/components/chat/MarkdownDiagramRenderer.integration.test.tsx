import { render, waitFor } from '@testing-library/react'
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

const MULTILINE_MERMAID = `flowchart TD
    APP["开发者代码<br/>app.js / pages"]
    SDK["wbx.cloud 客户端 SDK"]
    INIT["init<br/>记录默认 env"]
    CALL["callFunction<br/>校验入参 / 解析 env / 序列化 data"]
    APP -->|init| INIT
    APP -->|callFunction| CALL
    INIT --> SDK
    linkStyle default stroke:#2166cc`

test('renders Mermaid HTML labels containing line breaks', async () => {
  const { container } = render(
    <MarkdownDiagramPreview code={MULTILINE_MERMAID} language="mermaid" />
  )

  await waitFor(
    () => {
      const svg = container.querySelector('.drawing-diagram-svg')
      expect(svg).toBeInTheDocument()
      expect(svg).toHaveTextContent('开发者代码')
      expect(svg).toHaveTextContent('app.js / pages')
      expect(svg).toHaveAttribute('data-mermaid-layout-isolated', 'true')
      const arrows = Array.from(svg!.querySelectorAll('[marker-end]'))
      expect(arrows.length).toBeGreaterThan(0)
      for (const arrow of arrows) {
        const markerId = arrow.getAttribute('marker-end')?.match(/#([^)'"\s]+)/)?.[1]
        const marker = Array.from(svg!.querySelectorAll('marker')).find(
          node => node.id === markerId
        )
        expect(marker).toBeDefined()
        expect(marker?.querySelector('path')?.getAttribute('stroke')).toBe('#2166cc')
      }
      expect(document.querySelector('[data-file-viewer-mermaid-isolate]')).toBeNull()
      expect(container.querySelector('.drawing-state.error')).not.toBeInTheDocument()
    },
    { timeout: 10_000 }
  )
}, 15_000)

test('reuses sanitized Mermaid results with independent SVG references and theme keys', async () => {
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
  const waitUntilReady = async (container: HTMLElement, count: number) => {
    await waitFor(() => {
      expect(container.querySelectorAll('.drawing-diagram-svg')).toHaveLength(count)
      expect(container.querySelector('.drawing-state:not([hidden])')).not.toBeInTheDocument()
    })
    return Array.from(container.querySelectorAll<SVGSVGElement>('.drawing-diagram-svg'))
  }

  try {
    const first = render(preview('light', 2))
    const firstSvgs = await waitUntilReady(first.container, 2)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    const firstIds = firstSvgs.flatMap(svg => [
      svg.id,
      ...Array.from(svg.querySelectorAll('[id]'), node => node.id),
    ])
    expect(new Set(firstIds).size).toBe(firstIds.length)
    for (const svg of firstSvgs) {
      expect(svg.querySelector('script')).not.toBeInTheDocument()
      expect(svg.getAttribute('aria-labelledby')).toBe(svg.querySelector('title')?.id)
      expect(svg.querySelector('use')?.getAttribute('href')).toBe(`#${svg.querySelector('g')?.id}`)
      expect(svg.querySelector('[marker-end]')?.getAttribute('marker-end')).toBe(
        `url(#${svg.querySelector('marker')?.id})`
      )
      expect(svg.querySelector('style')?.textContent).toContain(`#${svg.id}`)
      expect(svg.querySelector('style')?.textContent).toContain('fill:#fff')
      expect(svg.querySelector('style')?.textContent).toContain(`#${svg.querySelector('g')?.id}`)
    }
    first.unmount()

    const second = render(preview('light', 1))
    const [cached] = await waitUntilReady(second.container, 1)
    expect(renderMermaid).toHaveBeenCalledTimes(1)
    expect(cached).toHaveAttribute('data-diagram-cache-hit', 'true')
    expect(firstIds).not.toContain(cached.id)
    second.rerender(preview('dark', 1))
    await waitFor(() => {
      expect(renderMermaid).toHaveBeenCalledTimes(2)
      expect(second.container.querySelector('.drawing-diagram-svg')).toHaveAttribute(
        'data-diagram-cache-hit',
        'false'
      )
    })
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

    await waitFor(() => expect(container.querySelector('.drawing-diagram-svg')).toBeInTheDocument())

    const svg = container.querySelector('.drawing-diagram-svg')
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(svg?.querySelector('script')).not.toBeInTheDocument()
    expect(svg).not.toHaveAttribute('onload')
    expect(svg?.querySelector('style')).not.toBeInTheDocument()
    expect(svg?.querySelector('a')).not.toHaveAttribute('href')
    expect(svg?.querySelector('use')).toHaveAttribute('href', '#safe-symbol')
    expect(svg?.querySelector('#unsafe-xlink')).not.toHaveAttribute('xlink:href')
    expect(svg?.querySelector('image')).not.toHaveAttribute('href')
    expect(container.querySelector('.drawing-state.error')).not.toBeInTheDocument()
  } finally {
    fetchMock.mockRestore()
  }
}, 15_000)
