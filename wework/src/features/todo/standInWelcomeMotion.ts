export type StandInWelcomeShape = 'idle' | 'connection' | 'agenda'

const pointCount = 288
const goldenAngle = Math.PI * (3 - Math.sqrt(5))

function destination(index: number, shape: StandInWelcomeShape, time: number) {
  if (shape === 'connection') {
    const cluster = Math.floor(index / 96)
    const progress = time % 3.2
    if (cluster === 1) {
      const x = ((index % 32) - 15.5) * 0.036
      const signal = Math.exp(-((x - progress + 0.92) ** 2) * 26)
      return { x, y: ((Math.floor(index / 32) % 3) - 1) * 0.055, light: 0.35 + signal * 0.6 }
    }
    const angle = ((index % 32) * Math.PI) / 16
    const radius = 0.22 + (Math.floor(index / 32) % 3) * 0.045
    const signal = Math.exp(-((progress - (cluster === 0 ? 0.35 : 1.65)) ** 2) * 12)
    return {
      x: (cluster - 1) * 0.83 + Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      light: 0.38 + signal * 0.52,
    }
  }
  if (shape === 'agenda') {
    const cell = Math.floor(index / 48)
    const step = (time % 4.6) - cell * 0.47
    const focus = Math.exp(-((step - 0.45) ** 2) * 13)
    return {
      x: ((cell % 3) - 1) * 0.66 + ((index % 8) - 3.5) * 0.047,
      y: (Math.floor(cell / 3) - 0.5) * 0.42 + ((Math.floor(index / 8) % 6) - 2.5) * 0.044,
      light: 0.38 + focus * 0.52,
    }
  }
  const z = 1 - (2 * (index + 0.5)) / pointCount
  const extent = Math.sqrt(1 - z * z)
  const angle = goldenAngle * index + time * 0.32
  const depth = Math.sin(angle) * extent
  const breathing = 1 + 0.055 * Math.sin(time * 1.6 + z)
  return {
    x: Math.cos(angle) * extent * breathing * (1 + depth * 0.18),
    y: z * 0.48 * breathing + 0.06 * Math.sin(angle * 2 + time),
    light: 0.35 + (depth + 1) * 0.27,
  }
}

export function animateStandInWelcome(
  canvas: HTMLCanvasElement,
  getShape: () => StandInWelcomeShape
) {
  const context = canvas.getContext('2d')
  if (!context) return
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const points = Array.from({ length: pointCount }, (_, index) => destination(index, 'idle', 0))
  let width = 0
  let height = 0
  let frame = 0
  const draw = (now: number) => {
    const time = reducedMotion.matches ? 0 : now / 1000
    const shape = getShape()
    const scale = Math.min(width * 0.4, height * 0.72)
    context.clearRect(0, 0, width, height)
    points.forEach((point, index) => {
      const target = destination(index, shape, time)
      const move = reducedMotion.matches ? 1 : 0.09
      point.x += (target.x - point.x) * move
      point.y += (target.y - point.y) * move
      context.fillStyle = `rgba(77, 111, 209, ${target.light})`
      context.beginPath()
      context.arc(width / 2 + point.x * scale, height / 2 + point.y * scale, 1.1, 0, Math.PI * 2)
      context.fill()
    })
    if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(draw)
  }
  const resize = () => {
    const bounds = canvas.getBoundingClientRect()
    width = bounds.width
    height = bounds.height
    const scale = Math.min(window.devicePixelRatio, 2)
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    context.setTransform(scale, 0, 0, scale, 0, 0)
    if (reducedMotion.matches) draw(0)
  }
  const observer = new ResizeObserver(resize)
  observer.observe(canvas)
  const resume = () => {
    cancelAnimationFrame(frame)
    if (!document.hidden) frame = requestAnimationFrame(draw)
  }
  document.addEventListener('visibilitychange', resume)
  reducedMotion.addEventListener('change', resume)
  resume()
  return {
    redraw: () => {
      if (reducedMotion.matches) draw(0)
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      document.removeEventListener('visibilitychange', resume)
      reducedMotion.removeEventListener('change', resume)
    },
  }
}
