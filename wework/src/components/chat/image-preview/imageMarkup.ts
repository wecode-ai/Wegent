import type { ImagePoint, ImageStroke } from './imageEdit'

export const markupShapes = [
  'line',
  'arrow',
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'star',
  'heart',
] as const

export type MarkupShape = (typeof markupShapes)[number]

export interface MarkupStroke extends ImageStroke {
  color: string
  shape?: MarkupShape
}

export interface MarkupText {
  point: ImagePoint
  text: string
  color: string
  size: number
}

export type ImageMark = (MarkupStroke | MarkupText) & { erasures?: ImageStroke[] }

export function markupSurfaceSize({ width, height }: { width: number; height: number }) {
  const scale = Math.max(width, height) / 100
  return { width: width / scale, height: height / scale, scale }
}

function strokeBounds(points: ImagePoint[], padding: number) {
  let left = Infinity
  let top = Infinity
  let right = -Infinity
  let bottom = -Infinity
  for (const { x, y } of points) {
    left = Math.min(left, x - padding)
    top = Math.min(top, y - padding)
    right = Math.max(right, x + padding)
    bottom = Math.max(bottom, y + padding)
  }
  return { left, top, right, bottom }
}

export function eraseMarks(marks: ImageMark[], stroke: ImageStroke): ImageMark[] {
  const cut = strokeBounds(stroke.points, stroke.width / 2)
  return marks.map(mark => {
    const bounds =
      'text' in mark
        ? {
            left: mark.point.x - mark.size,
            right: mark.point.x + mark.size * (mark.text.length + 1),
            top: mark.point.y - mark.size,
            bottom: mark.point.y + mark.size,
          }
        : strokeBounds(mark.points, mark.width / 2 + (mark.shape ? 5 : 0))
    if (
      bounds.left > cut.right ||
      bounds.right < cut.left ||
      bounds.top > cut.bottom ||
      bounds.bottom < cut.top
    )
      return mark
    return { ...mark, erasures: [...(mark.erasures ?? []), stroke] }
  })
}

function polygon(points: number[][], closed = true) {
  return (
    points.map(([x, y], index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ') +
    (closed ? ' Z' : '')
  )
}

function markupPath(stroke: ImageStroke | MarkupStroke): string {
  const [first, ...rest] = stroke.points
  if (!first) return ''
  const last = rest.at(-1) ?? first
  const shape = 'shape' in stroke ? stroke.shape : undefined
  if (!shape) {
    const points = rest.some(point => point.x !== first.x || point.y !== first.y)
      ? rest
      : [{ x: first.x + 0.001, y: first.y }]
    return polygon(
      [first, ...points].map(({ x, y }) => [x, y]),
      false
    )
  }
  const { x: a, y: b } = first
  const { x: c, y: d } = last
  const x = Math.min(a, c)
  const y = Math.min(b, d)
  const w = Math.abs(c - a)
  const h = Math.abs(d - b)
  const centerX = x + w / 2
  const centerY = y + h / 2
  switch (shape) {
    case 'line':
      return `M ${a} ${b} L ${c} ${d}`
    case 'arrow': {
      const angle = Math.atan2(d - b, c - a)
      const head = Math.min(5, Math.hypot(c - a, d - b) / 3)
      const edge = (offset: number) =>
        `${c - head * Math.cos(angle + offset)} ${d - head * Math.sin(angle + offset)}`
      return `M ${a} ${b} L ${c} ${d} M ${edge(-0.55)} L ${c} ${d} L ${edge(0.55)}`
    }
    case 'rectangle':
      return `M ${x} ${y} h ${w} v ${h} h ${-w} Z`
    case 'ellipse':
      return `M ${x} ${centerY} a ${w / 2} ${h / 2} 0 1 0 ${w} 0 a ${w / 2} ${h / 2} 0 1 0 ${-w} 0 Z`
    case 'triangle':
      return polygon([
        [centerX, y],
        [x + w, y + h],
        [x, y + h],
      ])
    case 'diamond':
      return polygon([
        [centerX, y],
        [x + w, centerY],
        [centerX, y + h],
        [x, centerY],
      ])
    case 'star':
      return polygon(
        Array.from({ length: 10 }, (_, index) => {
          const angle = (index * Math.PI) / 5 - Math.PI / 2
          const radius = index % 2 ? 0.2 : 0.5
          return [centerX + w * radius * Math.cos(angle), centerY + h * radius * Math.sin(angle)]
        })
      )
    case 'heart':
      return `M ${centerX} ${y + h} C ${x - w * 0.48} ${y + h * 0.3}, ${x + w * 0.2} ${y - h * 0.27}, ${centerX} ${y + h * 0.22} C ${x + w * 0.8} ${y - h * 0.27}, ${x + w * 1.48} ${y + h * 0.3}, ${centerX} ${y + h} Z`
  }
}

const strokePaths = new WeakMap<ImageStroke, { path: string; filled: boolean }>()

export function strokeGeometry(stroke: ImageStroke | MarkupStroke) {
  const cached = strokePaths.get(stroke)
  if (cached) return cached
  const filled = stroke.points.some(point => point.pressure !== undefined)
  const path = filled ? penOutline(stroke) : markupPath(stroke)
  const geometry = { path, filled }
  strokePaths.set(stroke, geometry)
  return geometry
}

function penOutline(stroke: ImageStroke) {
  // A tapered segment and a round dab per sample keep pressure changes and joins continuous.
  const parts: string[] = []
  let previous: (ImagePoint & { radius: number }) | undefined
  for (const point of stroke.points) {
    const { x, y } = point
    const radius =
      (stroke.width / 2) * (0.42 + 0.58 * Math.sin(((point.pressure ?? 1) * Math.PI) / 2))
    if (previous) {
      const dx = x - previous.x
      const dy = y - previous.y
      const distance = Math.hypot(dx, dy)
      if (distance > 0.0001) {
        const normalX = -dy / distance
        const normalY = dx / distance
        parts.push(
          polygon([
            [previous.x + normalX * previous.radius, previous.y + normalY * previous.radius],
            [x + normalX * radius, y + normalY * radius],
            [x - normalX * radius, y - normalY * radius],
            [previous.x - normalX * previous.radius, previous.y - normalY * previous.radius],
          ])
        )
      }
    }
    parts.push(
      `M ${x + radius} ${y} a ${radius} ${radius} 0 1 0 ${-2 * radius} 0 a ${radius} ${radius} 0 1 0 ${2 * radius} 0 Z`
    )
    previous = { ...point, radius }
  }
  return parts.join(' ')
}

export function moveMark(mark: ImageMark, dx: number, dy: number): ImageMark {
  const move = (point: ImagePoint) => ({ ...point, x: point.x + dx, y: point.y + dy })
  const moved =
    'text' in mark
      ? { ...mark, point: move(mark.point) }
      : { ...mark, points: mark.points.map(move) }
  if (!mark.erasures) return moved
  return {
    ...moved,
    erasures: mark.erasures.map(erase => ({ ...erase, points: erase.points.map(move) })),
  }
}
