import { render, waitFor } from '@testing-library/react'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
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
    INIT --> SDK`

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
      expect(container.querySelector('.drawing-state.error')).not.toBeInTheDocument()
    },
    { timeout: 10_000 }
  )
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
