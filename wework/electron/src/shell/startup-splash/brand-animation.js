;(() => {
  const WIDTH = 1200
  const HEIGHT = 680
  const CENTER_X = 600
  const CENTER_Y = 340
  const FORMATION_DURATION_MS = 5600
  const STRAND_DENSITY = 1.5
  const PLAYBACK_SPEED = 1
  const BREATHING_SCALE = 1.018
  const GLOW_MARGIN = 16
  const FOOTER_GAP = 8
  const STREAM_COUNT = Math.round(32 + STRAND_DENSITY * 16)
  const TAU = Math.PI * 2

  const clamp = value => Math.max(0, Math.min(1, value))
  const mix = (start, end, amount) => start + (end - start) * amount
  const ease = value => 0.5 - 0.5 * Math.cos(Math.PI * clamp(value))
  const noise = value => (((Math.sin(value * 127.1 + 311.7) * 43758.5453) % 1) + 1) % 1

  function smooth(start, end, value) {
    const amount = clamp((value - start) / (end - start))
    return amount * amount * (3 - 2 * amount)
  }

  function createLogoPath() {
    const path = new Path2D()
    const contours = window.WEWORK_STARTUP_BRAND_CONTOURS
    const coordinates = contours.flatMap(contour => contour.points)
    const xs = coordinates.map(([x]) => x)
    const ys = coordinates.map(([, y]) => y)
    const originX = (Math.min(...xs) + Math.max(...xs)) / 2
    const originY = (Math.min(...ys) + Math.max(...ys)) / 2
    contours.forEach(contour => {
      const points = contour.points.map(([x, y]) => ({
        x: (x - originX) * 1.12,
        y: (y - originY) * 1.12,
      }))
      const first = points[0]
      path.moveTo(first.x, first.y)
      points.slice(1).forEach(point => path.lineTo(point.x, point.y))
      path.closePath()
    })
    return {
      path,
      halfWidth: ((Math.max(...xs) - Math.min(...xs)) / 2) * 1.12,
      halfHeight: ((Math.max(...ys) - Math.min(...ys)) / 2) * 1.12,
    }
  }

  function createCanvas(width, height) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    return canvas
  }

  function contextFor(canvas, options) {
    const context = canvas.getContext('2d', options)
    if (!context) throw new Error('The startup brand animation requires a 2D canvas')
    return context
  }

  function createSilhouetteTest(logoPath) {
    const mask = createCanvas(600, 600)
    const context = contextFor(mask, { willReadFrequently: true })
    context.translate(300, 300)
    context.fill(logoPath)
    const pixels = context.getImageData(0, 0, 600, 600).data
    return (x, y) => {
      const column = Math.round(x + 300)
      const row = Math.round(y + 300)
      return (
        column >= 0 &&
        column < 600 &&
        row >= 0 &&
        row < 600 &&
        pixels[(row * 600 + column) * 4 + 3] > 180
      )
    }
  }

  function measurePath(points) {
    const distances = [0]
    for (let index = 1; index < points.length; index++) {
      const previous = points[index - 1]
      const point = points[index]
      distances.push(distances[index - 1] + Math.hypot(point.x - previous.x, point.y - previous.y))
    }
    return { points, distances, length: distances[distances.length - 1] }
  }

  function pathPosition(path, fraction) {
    const distance = clamp(fraction) * path.length
    let low = 0
    let high = path.points.length - 1
    while (low + 1 < high) {
      const middle = (low + high) >> 1
      if (path.distances[middle] < distance) low = middle
      else high = middle
    }
    const amount =
      (distance - path.distances[low]) / (path.distances[high] - path.distances[low] || 1)
    return {
      x: mix(path.points[low].x, path.points[high].x, amount),
      y: mix(path.points[low].y, path.points[high].y, amount),
    }
  }

  function pathSection(path, start, end) {
    const points = []
    const count = Math.max(2, Math.ceil(((end - start) * path.length) / 4))
    for (let index = 0; index <= count; index++) {
      points.push(pathPosition(path, mix(start, end, index / count)))
    }
    return points
  }

  function collectFiberSegments(inside, family, row, fibers) {
    let points = []
    const keepSegment = () => {
      if (points.length > 3) {
        fibers.push({
          points,
          family,
          birth: 1.2 + noise(fibers.length + 3) * 1.8,
          grow: 0.65 + noise(fibers.length + 9) * 0.8,
        })
      }
      points = []
    }
    for (let x = -252; x <= 252; x += 2.5) {
      const y =
        -332 + row * 5.6 + x * (family ? -0.55 : 0.55) + Math.sin(x * 0.025 + row * 0.32) * 2.6
      if (inside(x, y)) points.push({ x, y })
      else keepSegment()
    }
    keepSegment()
  }

  function createFibers(logoPath) {
    const inside = createSilhouetteTest(logoPath)
    const fibers = []
    for (let family = 0; family < 2; family++) {
      for (let row = 0; row < 118; row++) {
        collectFiberSegments(inside, family, row, fibers)
      }
    }
    return fibers
  }

  function cubicPoint(start, controlA, controlB, end, amount) {
    const inverse = 1 - amount
    const startWeight = inverse * inverse * inverse
    const firstWeight = 3 * inverse * inverse * amount
    const secondWeight = 3 * inverse * amount * amount
    const endWeight = amount * amount * amount
    return {
      x:
        startWeight * start.x +
        firstWeight * controlA.x +
        secondWeight * controlB.x +
        endWeight * end.x,
      y:
        startWeight * start.y +
        firstWeight * controlA.y +
        secondWeight * controlB.y +
        endWeight * end.y,
    }
  }

  function chooseFiber(fibers, direction, index) {
    const alignment = point =>
      (point.x * direction.x + point.y * direction.y) / (Math.hypot(point.x, point.y) || 1)
    const candidates = fibers.filter(fiber => {
      const first = fiber.points[0]
      const last = fiber.points[fiber.points.length - 1]
      return Math.max(alignment(first), alignment(last)) > 0.65
    })
    return candidates[Math.floor(noise(index * 3 + 4) * candidates.length)]
  }

  function orientFiber(fiber, direction) {
    const points = [...fiber.points]
    const first = points[0]
    const last = points[points.length - 1]
    if (
      first.x * direction.x + first.y * direction.y <
      last.x * direction.x + last.y * direction.y
    ) {
      points.reverse()
    }
    return points
  }

  function createIncomingRoute(points, direction, index) {
    const tangent = { x: -direction.y, y: direction.x }
    const target = points[0]
    const radius = Math.min(
      660 / Math.max(0.001, Math.abs(direction.x)),
      410 / Math.max(0.001, Math.abs(direction.y))
    )
    const start = { x: direction.x * radius, y: direction.y * radius }
    const curl = (index % 2 ? 1 : -1) * (80 + noise(index + 1) * 100)
    const controlA = {
      x: mix(start.x, target.x, 0.43) + tangent.x * curl,
      y: mix(start.y, target.y, 0.43) + tangent.y * curl,
    }
    const next = points[1]
    const along = Math.hypot(next.x - target.x, next.y - target.y)
    const controlB = {
      x: target.x - ((next.x - target.x) / along) * 88,
      y: target.y - ((next.y - target.y) / along) * 88,
    }
    const route = []
    for (let step = 0; step <= 80; step++) {
      route.push(cubicPoint(start, controlA, controlB, target, step / 80))
    }
    return route
  }

  function createStream(fibers, index) {
    const group = index % 8
    const angle = (group * TAU) / 8 + (noise(index + 10) - 0.5) * 0.32
    const direction = { x: Math.cos(angle), y: Math.sin(angle) }
    const fiber = chooseFiber(fibers, direction, index)
    const points = orientFiber(fiber, direction)
    const route = createIncomingRoute(points, direction, index)
    const incomingLength = measurePath(route).length
    route.push(...points.slice(1))
    const path = measurePath(route)
    const birth = 0.03 + Math.floor(index / 8) * 0.28 + (group % 2) * 0.1 + noise(index + 12) * 0.08
    const travel = 1.95 + noise(index + 20) * 0.4
    const arrivalFraction = incomingLength / path.length
    const arrivalProgress = Math.acos(1 - 2 * arrivalFraction) / Math.PI
    const arrival = birth + travel * arrivalProgress
    const stream = {
      path,
      birth,
      travel,
      arrivalFraction,
      arrival,
      reversed: points[0] !== fiber.points[0],
    }
    if (!fiber.owner || stream.arrival < fiber.owner.arrival) fiber.owner = stream
    return stream
  }

  function prepareFiber(fiber, index) {
    fiber.path = measurePath(fiber.points)
    fiber.reversePath = measurePath([...fiber.points].reverse())
    fiber.brightness = 0.3 + noise(index + 7) * 0.38
    fiber.ink = new Path2D()
    fiber.ink.moveTo(fiber.points[0].x, fiber.points[0].y)
    fiber.points.slice(1).forEach(point => fiber.ink.lineTo(point.x, point.y))
  }

  function stroke(context, points, color, width) {
    if (points.length < 2) return
    context.beginPath()
    context.moveTo(points[0].x, points[0].y)
    for (let index = 1; index < points.length; index++) {
      context.lineTo(points[index].x, points[index].y)
    }
    context.strokeStyle = color
    context.lineWidth = width
    context.stroke()
  }

  function paintBackdrop(context, canvas, time, logo, viewport) {
    const { width, height } = canvas
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, width, height)
    const glow = GLOW_MARGIN * viewport.pixelRatio
    const belowCenter = viewport.footerTop - height / 2 - glow - FOOTER_GAP * viewport.pixelRatio
    const fit = Math.max(
      0,
      Math.min(
        width / WIDTH,
        height / HEIGHT,
        (width / 2 - glow) / (logo.halfWidth * BREATHING_SCALE),
        (height / 2 - glow) / (logo.halfHeight * BREATHING_SCALE),
        belowCenter / (logo.halfHeight * BREATHING_SCALE)
      )
    )
    // Status and recovery controls take precedence when they cover the full-window center.
    if (fit === 0) return false
    context.setTransform(fit, 0, 0, fit, (width - WIDTH * fit) / 2, (height - HEIGHT * fit) / 2)
    const aura = context.createRadialGradient(CENTER_X, CENTER_Y, 30, CENTER_X, 310, 400)
    aura.addColorStop(0, `rgba(12, 59, 126, ${0.08 + 0.15 * smooth(1, 3, time)})`)
    aura.addColorStop(1, 'rgba(5, 7, 13, 0)')
    context.fillStyle = aura
    context.fillRect(0, 0, WIDTH, HEIGHT)
    return true
  }

  function paintMaterial(context, logoPath, time) {
    const solid = smooth(3.25, 4.7, time)
    context.save()
    context.translate(CENTER_X, CENTER_Y)
    const material = context.createLinearGradient(-220, -210, 220, 210)
    material.addColorStop(0, '#74d5ff')
    material.addColorStop(0.32, '#149aff')
    material.addColorStop(0.72, '#0867d4')
    material.addColorStop(1, '#43b9ff')
    context.globalAlpha = solid
    context.fillStyle = material
    context.shadowBlur = 12
    context.shadowColor = '#168eff'
    context.fill(logoPath)
    context.restore()
  }

  function paintFiber(context, fiber, time, settle) {
    const owner = fiber.owner
    const amount = owner
      ? clamp(
          (ease((time - owner.birth) / owner.travel) - owner.arrivalFraction) /
            (1 - owner.arrivalFraction)
        )
      : ease((time - fiber.birth) / fiber.grow)
    if (amount <= 0) return
    const brightness = fiber.brightness * (1 - settle * 0.94)
    const tint = fiber.family ? '118, 186, 255' : '212, 242, 255'
    const color = `rgba(${tint}, ${brightness})`
    const width = fiber.family ? 0.85 : 1
    if (amount < 1) {
      const path = owner?.reversed ? fiber.reversePath : fiber.path
      stroke(context, pathSection(path, 0, amount), color, width)
      return
    }
    context.strokeStyle = color
    context.lineWidth = width
    context.stroke(fiber.ink)
  }

  function paintStream(context, stream, index, time) {
    const elapsed = time - stream.birth
    if (elapsed <= 0 || elapsed >= stream.travel + 0.4) return
    const head = ease(elapsed / stream.travel)
    const tail = mix(
      Math.max(0, head - 0.62),
      stream.arrivalFraction,
      smooth(stream.arrival, stream.birth + stream.travel + 0.12, time)
    )
    if (tail >= head) return
    const points = pathSection(stream.path, tail, head)
    const start = points[0]
    const end = points[points.length - 1]
    const fade =
      smooth(0, 0.24, elapsed) * (1 - smooth(stream.travel, stream.travel + 0.4, elapsed))
    const gradient = context.createLinearGradient(start.x, start.y, end.x + 0.01, end.y + 0.01)
    gradient.addColorStop(0, 'rgba(69, 138, 255, 0)')
    gradient.addColorStop(0.28, `rgba(68, 150, 255, ${fade * 0.35})`)
    gradient.addColorStop(0.72, `rgba(157, 213, 255, ${fade * 0.72})`)
    gradient.addColorStop(1, `rgba(226, 248, 255, ${fade * 0.92})`)
    stroke(context, points, gradient, index % 5 === 0 ? 1.8 : 1.15)
  }

  function paintFilaments(context, logoPath, fibers, streams, time) {
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, WIDTH, HEIGHT)
    context.save()
    context.translate(CENTER_X, CENTER_Y)
    context.lineCap = 'round'
    context.lineJoin = 'round'
    const woven = smooth(0.7, 2, time)
    const settle = smooth(3.65, 4.9, time)
    context.strokeStyle = `rgba(94, 180, 255, ${woven * (0.09 + 0.12 * (1 - settle))})`
    context.lineWidth = 0.8
    context.stroke(logoPath)
    fibers.forEach(fiber => paintFiber(context, fiber, time, settle))
    streams.forEach((stream, index) => paintStream(context, stream, index, time))
    const ignition = Math.exp(-Math.pow((time - 3.65) / 0.4, 2))
    const solid = smooth(3.25, 4.7, time)
    context.strokeStyle = `rgba(209, 242, 255, ${ignition * 0.7 + solid * 0.18})`
    context.lineWidth = 1.3 + ignition * 1.5
    context.stroke(logoPath)
    context.restore()
  }

  function compositeGlow(context, layer) {
    context.save()
    context.globalCompositeOperation = 'screen'
    context.globalAlpha = 0.8
    context.filter = 'blur(8px)'
    context.drawImage(layer, 0, 0)
    context.filter = 'blur(2px)'
    context.drawImage(layer, 0, 0)
    context.globalAlpha = 1
    context.filter = 'none'
    context.drawImage(layer, 0, 0)
    context.restore()
  }

  function createRenderer(canvas, viewport) {
    const context = contextFor(canvas)
    const logo = createLogoPath()
    const logoPath = logo.path
    const fibers = createFibers(logoPath)
    const streams = Array.from({ length: STREAM_COUNT }, (_, index) => createStream(fibers, index))
    fibers.forEach(prepareFiber)
    const filamentLayer = createCanvas(WIDTH, HEIGHT)
    const ink = contextFor(filamentLayer)
    return time => {
      if (!paintBackdrop(context, canvas, time, logo, viewport)) return
      paintMaterial(context, logoPath, time)
      paintFilaments(ink, logoPath, fibers, streams, time)
      compositeGlow(context, filamentLayer)
    }
  }

  function createStartupBrandAnimation(canvas, footerElement) {
    const container = canvas.parentElement
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const viewport = { footerTop: 0, pixelRatio: 1 }
    const render = createRenderer(canvas, viewport)
    let elapsed = motionQuery.matches ? FORMATION_DURATION_MS : 0
    let externalPause = false
    let destroyed = false
    let frameId = null
    let previousTime = null
    let completionPromise = null
    let completion = null

    function paused() {
      return externalPause || document.hidden || motionQuery.matches
    }

    function cancelFrame() {
      if (frameId !== null) window.cancelAnimationFrame(frameId)
      frameId = null
      previousTime = null
    }

    function syncPlayback() {
      container.classList.toggle('is-paused', paused())
      container.classList.toggle(
        'is-breathing',
        elapsed >= FORMATION_DURATION_MS &&
          !motionQuery.matches &&
          !destroyed &&
          completionPromise === null
      )
      const resting =
        completion === null &&
        (paused() || elapsed >= FORMATION_DURATION_MS || completionPromise !== null)
      if (destroyed || resting) cancelFrame()
      else if (frameId === null) frameId = window.requestAnimationFrame(frame)
    }

    function readBreathingPose() {
      if (!container.classList.contains('is-breathing')) return { scale: 1, brightness: 1 }
      const style = window.getComputedStyle(canvas)
      const brightness = style.filter.match(/brightness\(([\d.]+)\)/)
      return {
        scale: style.transform === 'none' ? 1 : new DOMMatrixReadOnly(style.transform).a,
        brightness: brightness ? Number(brightness[1]) : 1,
      }
    }

    function paintPose(pose, amount) {
      canvas.style.transform = `scale(${mix(pose.scale, 1, amount)})`
      canvas.style.filter = `brightness(${mix(pose.brightness, 1, amount)})`
    }

    function finishCompletion() {
      const pending = completion
      completion = null
      elapsed = FORMATION_DURATION_MS
      paintPose({ scale: 1, brightness: 1 }, 1)
      render(elapsed / 1000)
      syncPlayback()
      pending.resolve()
    }

    function renderCompletion(timestamp) {
      if (document.hidden || motionQuery.matches) {
        finishCompletion()
        return
      }
      const amount = smooth(0, completion.duration, timestamp - completion.startedAt)
      if (amount >= 1) {
        finishCompletion()
        return
      }
      elapsed = mix(completion.formation, FORMATION_DURATION_MS, amount)
      paintPose(completion.pose, amount)
      render(elapsed / 1000)
    }

    function frame(timestamp) {
      frameId = null
      if (destroyed) return
      if (completion) renderCompletion(timestamp)
      else if (!paused() && completionPromise === null) {
        if (previousTime !== null) {
          elapsed = Math.min(
            FORMATION_DURATION_MS,
            elapsed + (timestamp - previousTime) * PLAYBACK_SPEED
          )
        }
        previousTime = timestamp
        render(elapsed / 1000)
      }
      syncPlayback()
    }

    function resize() {
      if (destroyed) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!width || !height) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
      const bounds = container.getBoundingClientRect()
      const footer = footerElement.getBoundingClientRect()
      viewport.footerTop =
        Math.max(0, Math.min(height, footer.top - bounds.top)) * (canvas.height / height)
      viewport.pixelRatio = ratio
      render(elapsed / 1000)
    }

    function setPaused(value) {
      if (destroyed || externalPause === value) return
      externalPause = value
      if (value && completion) {
        const pending = completion
        completion = null
        cancelFrame()
        pending.reject(new Error('Startup brand completion was interrupted'))
      }
      syncPlayback()
    }

    function complete(durationMs = 200) {
      if (destroyed) return Promise.resolve()
      if (completionPromise !== null) return completionPromise
      if (externalPause) return Promise.reject(new Error('The startup brand animation is paused'))
      if (!Number.isFinite(durationMs) || durationMs < 0) {
        return Promise.reject(
          new RangeError('Startup brand completion duration must be nonnegative')
        )
      }
      const pose = readBreathingPose()
      cancelFrame()
      completionPromise = new Promise((resolve, reject) => {
        completion = {
          resolve,
          reject,
          pose,
          formation: elapsed,
          startedAt: performance.now(),
          duration: durationMs,
        }
      })
      paintPose(pose, 0)
      container.classList.remove('is-breathing')
      if (durationMs === 0 || document.hidden || motionQuery.matches) finishCompletion()
      else syncPlayback()
      return completionPromise
    }

    function motionChanged() {
      if (destroyed) return
      if (completion && motionQuery.matches) {
        finishCompletion()
        return
      }
      if (motionQuery.matches) elapsed = FORMATION_DURATION_MS
      render(elapsed / 1000)
      syncPlayback()
    }

    function visibilityChanged() {
      if (completion && document.hidden) finishCompletion()
      else syncPlayback()
    }

    function destroy() {
      if (destroyed) return
      destroyed = true
      cancelFrame()
      observer.disconnect()
      motionQuery.removeEventListener('change', motionChanged)
      document.removeEventListener('visibilitychange', visibilityChanged)
      window.removeEventListener('pagehide', destroy)
      container.classList.remove('is-breathing', 'is-paused')
      canvas.style.transform = ''
      canvas.style.filter = ''
      if (completion) {
        const pending = completion
        completion = null
        pending.resolve()
      }
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    observer.observe(footerElement)
    motionQuery.addEventListener('change', motionChanged)
    document.addEventListener('visibilitychange', visibilityChanged)
    window.addEventListener('pagehide', destroy)
    resize()
    syncPlayback()
    return { setPaused, complete, destroy }
  }

  window.createStartupBrandAnimation = createStartupBrandAnimation
})()
