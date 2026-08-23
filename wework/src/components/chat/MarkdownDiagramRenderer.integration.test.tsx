import { render, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { MarkdownDiagramPreview } from './MarkdownDiagramPreview'

const mermaidMocks = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="200" onload="alert('unsafe')">
      <style>@import "https://example.com/tracker.css"; .unsafe { background: url(https://example.com/tracker.png); }</style>
      <a href="javascript:alert('unsafe')">
        <text>unsafe link</text>
      </a>
      <use href="#safe-symbol" />
      <use id="unsafe-xlink" xlink:href="javascript:alert('unsafe')" />
      <image href="https://example.com/tracker.png" />
      <foreignObject width="400" height="200">
        <div xmlns="http://www.w3.org/1999/xhtml" onclick="alert('unsafe')" style="background:url(javascript:alert('unsafe'))">
          <p>开发者代码<br>app.js / pages</p>
          <img src="https://example.com/tracker.png" />
          <script>alert('unsafe')</script>
        </div>
      </foreignObject>
    </svg>`,
  })),
}))

vi.mock('mermaid', () => ({
  default: mermaidMocks,
}))

vi.mock('@panzoom/panzoom', () => ({
  default: () => ({
    destroy: vi.fn(),
    getScale: vi.fn(() => 1),
    reset: vi.fn(),
    zoom: vi.fn(),
    zoomWithWheel: vi.fn(),
  }),
}))

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
      expect(svg?.querySelector('script')).not.toBeInTheDocument()
      expect(svg).not.toHaveAttribute('onload')
      expect(svg?.querySelector('[onclick]')).not.toBeInTheDocument()
      expect(svg?.querySelector('style')).not.toBeInTheDocument()
      expect(svg?.querySelector('a')).not.toHaveAttribute('href')
      expect(svg?.querySelector('use')).toHaveAttribute('href', '#safe-symbol')
      expect(svg?.querySelector('#unsafe-xlink')).not.toHaveAttribute('xlink:href')
      expect(svg?.querySelector('image')).not.toHaveAttribute('href')
      expect(svg?.querySelector('[style]')).not.toBeInTheDocument()
      expect(svg?.querySelector('img')).not.toHaveAttribute('src')
      expect(container.querySelector('.drawing-state.error')).not.toBeInTheDocument()
    },
    { timeout: 10_000 }
  )

  expect(mermaidMocks.render).toHaveBeenCalledWith(expect.any(String), MULTILINE_MERMAID)
  expect(mermaidMocks.initialize).toHaveBeenCalledWith(
    expect.objectContaining({ securityLevel: 'strict' })
  )
}, 15_000)
