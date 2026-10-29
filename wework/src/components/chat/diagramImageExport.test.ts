import { expect, test, vi } from 'vitest'
import { captureDiagramArtifact, renderDiagramPng, serializeDiagramSvg } from './diagramImageExport'

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
  expect(
    new DOMParser().parseFromString(serialized, 'image/svg+xml').querySelector('parsererror')
  ).toBeNull()
})

test('captures the attachment diagram rather than an action icon', () => {
  const container = document.createElement('div')
  container.innerHTML =
    '<svg aria-label="icon"/><svg xmlns="http://www.w3.org/2000/svg" class="drawing-diagram-svg" viewBox="0 0 400 200"><text>Attachment</text></svg>'
  const diagram = container.querySelector('.drawing-diagram-svg')!
  Object.defineProperty(diagram, 'viewBox', { value: { baseVal: { width: 400, height: 200 } } })
  const artifact = captureDiagramArtifact(container)
  expect(artifact).toMatchObject({ width: 400, height: 200 })
  expect(artifact.svg).toContain('Attachment')
  expect(artifact.svg).not.toContain('icon')
  expect(
    new DOMParser().parseFromString(artifact.svg, 'image/svg+xml').querySelector('parsererror')
  ).toBeNull()
  expect(() => captureDiagramArtifact(null)).toThrow('not ready')
})

test('exports from cached dimensions without measuring transcript DOM and caps the canvas size', async () => {
  const blob = new Blob(['png'], { type: 'image/png' })
  const context = { scale: vi.fn(), fillRect: vi.fn(), drawImage: vi.fn(), fillStyle: '' }
  const canvasContext = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(context as unknown as CanvasRenderingContext2D)
  let dimensions: number[] = []
  const encode = vi
    .spyOn(HTMLCanvasElement.prototype, 'toBlob')
    .mockImplementation(function (callback) {
      dimensions = [this.width, this.height]
      callback(blob)
    })
  const bounds = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  vi.stubGlobal(
    'Image',
    class {
      onload?: () => void
      set src(_value: string) {
        queueMicrotask(() => this.onload?.())
      }
    }
  )
  try {
    expect(
      await renderDiagramPng(
        {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8000 2000"/>',
          src: '',
          width: 8000,
          height: 2000,
        },
        'dark'
      )
    ).toBe(blob)
    expect(bounds).not.toHaveBeenCalled()
    expect(dimensions).toEqual([4096, 1024])
    expect(context.fillStyle).toBe('#181818')
    expect(context.scale).toHaveBeenCalledWith(0.512, 0.512)
  } finally {
    canvasContext.mockRestore()
    encode.mockRestore()
    bounds.mockRestore()
    vi.unstubAllGlobals()
  }
})
