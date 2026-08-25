const MAX_EXPORT_EDGE = 4096
const EXPORT_SCALE = 2

function svgDimensions(svg: SVGSVGElement): { height: number; width: number } {
  const viewBox = svg.viewBox.baseVal
  const bounds = svg.getBoundingClientRect()
  return {
    width: Math.max(1, viewBox.width || bounds.width || 800),
    height: Math.max(1, viewBox.height || bounds.height || 600),
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('Failed to load the diagram SVG'))
    image.src = url
  })
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new Error('Failed to encode the diagram PNG'))
    }, 'image/png')
  })
}

export function serializeDiagramSvg(
  svg: SVGSVGElement,
  theme: 'dark' | 'light' | 'system',
  width: number,
  height: number
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(width))
  clone.setAttribute('height', String(height))
  replaceForeignObjects(clone, theme)
  return new XMLSerializer().serializeToString(clone)
}

function replaceForeignObjects(svg: SVGSVGElement, theme: 'dark' | 'light' | 'system'): void {
  svg.querySelectorAll('foreignObject').forEach(foreignObject => {
    const textContent = foreignObject.textContent?.replace(/\s+/g, ' ').trim()
    if (!textContent) {
      foreignObject.remove()
      return
    }

    const x = Number.parseFloat(foreignObject.getAttribute('x') ?? '0')
    const y = Number.parseFloat(foreignObject.getAttribute('y') ?? '0')
    const width = Number.parseFloat(foreignObject.getAttribute('width') ?? '0')
    const height = Number.parseFloat(foreignObject.getAttribute('height') ?? '0')
    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
    text.setAttribute('x', String(x + width / 2))
    text.setAttribute('y', String(y + height / 2))
    text.setAttribute('text-anchor', 'middle')
    text.setAttribute('dominant-baseline', 'central')
    text.setAttribute('font-family', 'Arial, sans-serif')
    text.setAttribute('font-size', '16')
    text.setAttribute('fill', theme === 'dark' ? '#f3f4f6' : '#111827')
    const transform = foreignObject.getAttribute('transform')
    if (transform) text.setAttribute('transform', transform)
    text.textContent = textContent
    foreignObject.replaceWith(text)
  })
}

export async function renderDiagramPng(
  container: HTMLElement,
  theme: 'dark' | 'light' | 'system'
): Promise<Blob> {
  const svg = container.querySelector<SVGSVGElement>('.drawing-diagram-svg')
  if (!svg) throw new Error('The diagram is not ready')

  const { width, height } = svgDimensions(svg)
  const scale = Math.min(EXPORT_SCALE, MAX_EXPORT_EDGE / Math.max(width, height))
  const source = serializeDiagramSvg(svg, theme, width, height)
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`)
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(width * scale)
  canvas.height = Math.ceil(height * scale)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is unavailable')

  context.scale(scale, scale)
  context.fillStyle = theme === 'dark' ? '#111316' : '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  return await canvasToPng(canvas)
}

export async function copyDiagramPng(blob: Blob): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image clipboard is unavailable')
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}

export async function saveDiagramPng(blob: Blob, filename: string): Promise<boolean> {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
  return true
}
