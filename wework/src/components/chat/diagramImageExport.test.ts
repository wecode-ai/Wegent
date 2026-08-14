import { expect, test } from 'vitest'
import { serializeDiagramSvg } from './diagramImageExport'

test('replaces Mermaid foreignObject labels before PNG export', () => {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <svg viewBox="0 0 200 100">
      <foreignObject x="20" y="30" width="80" height="40" transform="translate(2 3)">
        <div>Start <span>node</span></div>
      </foreignObject>
    </svg>
  `
  const svg = wrapper.querySelector('svg') as SVGSVGElement

  const serialized = serializeDiagramSvg(svg, 'dark', 200, 100)

  expect(serialized).not.toContain('foreignObject')
  expect(serialized).toContain('Start node')
  expect(serialized).toContain('x="60"')
  expect(serialized).toContain('y="50"')
  expect(serialized).toContain('transform="translate(2 3)"')
  expect(serialized).toContain('fill="#f3f4f6"')
})
