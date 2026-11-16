;(() => {
  const WIDTH = 1200
  const HEIGHT = 680
  const CENTER_X = 600
  const CENTER_Y = 340
  const FORMATION_DURATION_MS = 5600
  const WAITING_START_MS = 4900
  const STRAND_DENSITY = 2.5
  const PLAYBACK_SPEED = 1
  const LOGO_SCALE = 1.12
  const GLOW_MARGIN = 16
  const FOOTER_GAP = 32
  const LOGO_CLEARANCE = 12
  const PALETTES = {
    dark: { aura: '12, 59, 126', auraOpacity: 0.055 },
    light: { aura: '37, 99, 180', auraOpacity: 0 },
  }
  const clamp = n => Math.max(0, Math.min(1, n))
  const mix = (a, b, t) => a + (b - a) * t
  const ease = n => {
    n = clamp(n)
    return n * n * (3 - 2 * n)
  }
  const ramp = (a, b, t) => ease((t - a) / (b - a))
  const smooth = ramp
  const noise = n => {
    const v = Math.sin(n * 91.77 + 41.3) * 16387.31
    return v - Math.floor(v)
  }
  const isDark = () => document.documentElement.dataset.theme === 'dark'

  function createLogoPath() {
    const path = new Path2D()
    const outline = []
    const contours = window.WEWORK_STARTUP_BRAND_CONTOURS
    const coordinates = contours.flatMap(contour => contour.curves.flat())
    const xs = coordinates.map(([x]) => x)
    const ys = coordinates.map(([, y]) => y)
    const originX = (Math.min(...xs) + Math.max(...xs)) / 2
    const originY = (Math.min(...ys) + Math.max(...ys)) / 2
    const sampledContours = []
    contours.forEach(contour => {
      const curves = contour.curves.map(curve =>
        curve.map(([x, y]) => ({ x: (x - originX) * LOGO_SCALE, y: (y - originY) * LOGO_SCALE }))
      )
      sampledContours.push(
        curves.flatMap(curve => Array.from({ length: 8 }, (_, index) => cubic(...curve, index / 8)))
      )
      const first = curves[0][0]
      path.moveTo(first.x, first.y)
      outline.push(`M${first.x} ${first.y}`)
      curves.forEach(([, controlA, controlB, end]) => {
        path.bezierCurveTo(controlA.x, controlA.y, controlB.x, controlB.y, end.x, end.y)
        outline.push(`C${controlA.x} ${controlA.y} ${controlB.x} ${controlB.y} ${end.x} ${end.y}`)
      })
      path.closePath()
      outline.push('Z')
    })
    return {
      path,
      contours: sampledContours,
      outline: outline.join(' '),
      halfWidth: ((Math.max(...xs) - Math.min(...xs)) / 2) * LOGO_SCALE,
      halfHeight: ((Math.max(...ys) - Math.min(...ys)) / 2) * LOGO_SCALE,
    }
  }

  function measure(points, closed = false) {
    const p = closed ? [...points, points[0]] : points
    const d = [0]
    for (let i = 1; i < p.length; i++)
      d.push(d[i - 1] + Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y))
    return { p, d, length: d.at(-1) }
  }
  function at(path, t) {
    const dist = clamp(t) * path.length
    let lo = 0,
      hi = path.p.length - 1
    while (lo + 1 < hi) {
      const m = (lo + hi) >> 1
      if (path.d[m] < dist) lo = m
      else hi = m
    }
    const n = (dist - path.d[lo]) / (path.d[hi] - path.d[lo] || 1)
    return { x: mix(path.p[lo].x, path.p[hi].x, n), y: mix(path.p[lo].y, path.p[hi].y, n) }
  }
  function stroke(ctx, points, color, width = 1) {
    if (points.length < 2) return
    ctx.beginPath()
    ctx.moveTo(points[0].x, points[0].y)
    points.slice(1).forEach(p => ctx.lineTo(p.x, p.y))
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  function section(path, a, b) {
    const n = Math.max(2, Math.ceil(((b - a) * path.length) / 5))
    return Array.from({ length: n + 1 }, (_, i) => at(path, mix(a, b, i / n)))
  }
  function cubic(a, b, c, d, t) {
    const u = 1 - t
    return {
      x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
      y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
    }
  }

  function createMeteorPainter(logo) {
    const contours = logo.contours
    const mark = logo.path
    const edges = contours.flatMap(contour =>
      contour.map((start, index) => {
        const end = contour[(index + 1) % contour.length]
        return {
          start,
          dx: end.x - start.x,
          dy: end.y - start.y,
          minX: Math.min(start.x, end.x),
          maxX: Math.max(start.x, end.x),
          minY: Math.min(start.y, end.y),
          maxY: Math.max(start.y, end.y),
        }
      })
    )
    const sampled = contours.map((p, i) => {
      const m = measure(p, true),
        n = i === 0 ? 280 : i === 1 ? 90 : 64
      return Array.from({ length: n }, (_, j) => at(m, j / n))
    })
    function firstContactDistance(path) {
      for (let i = 1; i < path.p.length; i++) {
        const a = path.p[i - 1],
          b = path.p[i]
        const dx = b.x - a.x,
          dy = b.y - a.y
        const minX = Math.min(a.x, b.x),
          maxX = Math.max(a.x, b.x),
          minY = Math.min(a.y, b.y),
          maxY = Math.max(a.y, b.y)
        let contact = Infinity
        for (const edge of edges) {
          if (edge.maxX < minX || edge.minX > maxX || edge.maxY < minY || edge.minY > maxY) continue
          const determinant = dx * edge.dy - dy * edge.dx
          if (Math.abs(determinant) < 1e-8) continue
          const cx = edge.start.x - a.x,
            cy = edge.start.y - a.y
          const t = (cx * edge.dy - cy * edge.dx) / determinant
          const u = (cx * dy - cy * dx) / determinant
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) contact = Math.min(contact, t)
        }
        if (Number.isFinite(contact)) return path.d[i - 1] + contact * (path.d[i] - path.d[i - 1])
      }
      return path.length
    }

    const routes = Array.from({ length: Math.round(24 * STRAND_DENSITY) }, (_, i) => {
      const shape = i % 9 < 6 ? 0 : i % 9 < 8 ? 1 : 2,
        p = sampled[shape],
        index = Math.floor(noise(i + 5) * p.length),
        target = p[index],
        angle = ((i % 8) * Math.PI) / 4 + (noise(i + 3) - 0.5) * 0.3
      const a = { x: Math.cos(angle) * 790, y: Math.sin(angle) * 580 },
        v = { x: -Math.sin(angle), y: Math.cos(angle) },
        curl = (i % 2 ? 1 : -1) * (65 + noise(i) * 85)
      const b = {
          x: mix(a.x, target.x, 0.5) + v.x * curl,
          y: mix(a.y, target.y, 0.45) + v.y * curl,
        },
        c = { x: target.x + Math.cos(angle) * 90, y: target.y + Math.sin(angle) * 90 }
      const incoming = Array.from({ length: 64 }, (_, j) => cubic(a, b, c, target, j / 63))
      const tail = Array.from(
        { length: Math.floor(p.length * 0.32) },
        (_, j) => p[(index + j) % p.length]
      )
      const path = measure([...incoming, ...tail])
      return {
        path,
        arrival: firstContactDistance(measure(incoming)) / path.length,
        birth: Math.floor(i / 8) * 0.17 + (i % 8) * 0.035,
        travel: 2.25 + noise(i + 41) * 0.45,
      }
    })
    const outlines = contours.map(p => measure(p, true))
    const stars = Array.from({ length: Math.round(44 * STRAND_DENSITY) }, (_, i) => ({
      x: (noise(i * 3 + 300) - 0.5) * 1320,
      y: (noise(i * 3 + 301) - 0.5) * 820,
      r: 0.35 + noise(i * 3 + 302) * 0.85,
      alpha: 0.12 + noise(i + 700) * 0.22,
    }))
    function paintStars(ctx, t, dark) {
      const fade = 1 - ramp(3.2, 5.2, t)
      if (fade <= 0) return
      stars.forEach(star => {
        const drift = 1 - ramp(0, 4.8, t) * 0.11
        ctx.beginPath()
        ctx.arc(star.x * drift, star.y * drift, star.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(${dark ? '151,201,255' : '55,105,160'},${fade * star.alpha * (dark ? 1 : 0.55)})`
        ctx.fill()
      })
    }
    function paintComet(ctx, route, index, t, dark) {
      const elapsed = t - route.birth
      if (elapsed <= 0 || elapsed > route.travel + 0.55) return
      const head = ease(elapsed / route.travel),
        tail = Math.max(0, head - (0.25 + noise(index + 80) * 0.12))
      const points = Array.from({ length: 33 }, (_, i) => at(route.path, mix(tail, head, i / 32)))
      const first = points[0],
        tip = points.at(-1),
        fade = ramp(0, 0.22, elapsed) * (1 - ramp(route.travel, route.travel + 0.55, elapsed))
      const rgb = dark ? '102,180,255' : '27,115,197',
        hot = dark ? '230,249,255' : '106,200,245'
      const gradient = ctx.createLinearGradient(first.x, first.y, tip.x + 0.001, tip.y + 0.001)
      gradient.addColorStop(0, `rgba(${rgb},0)`)
      gradient.addColorStop(0.5, `rgba(${rgb},${fade * 0.22})`)
      gradient.addColorStop(0.86, `rgba(${rgb},${fade * 0.7})`)
      gradient.addColorStop(1, `rgba(${hot},${fade * 0.95})`)
      const size = index % 7 === 0 ? 2.8 : 1.75
      for (let i = 1; i < points.length; i++)
        stroke(
          ctx,
          [points[i - 1], points[i]],
          gradient,
          0.12 + size * Math.pow(i / (points.length - 1), 1.8)
        )
      const headFade =
        fade *
        (1 -
          ramp(
            route.arrival - 48 / route.path.length,
            route.arrival - 14 / route.path.length,
            head
          ))
      if (headFade <= 0) return
      const radius = size * (dark ? 4.2 : 3.2),
        halo = ctx.createRadialGradient(tip.x, tip.y, 0, tip.x, tip.y, radius)
      halo.addColorStop(0, `rgba(${hot},${headFade * 0.8})`)
      halo.addColorStop(0.23, `rgba(${rgb},${headFade * (dark ? 0.45 : 0.18)})`)
      halo.addColorStop(1, `rgba(${rgb},0)`)
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, radius, 0, Math.PI * 2)
      ctx.fillStyle = halo
      ctx.fill()
      ctx.beginPath()
      ctx.arc(tip.x, tip.y, size * 0.88, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(${dark ? '237,252,255' : '32,129,211'},${headFade * 0.96})`
      ctx.fill()
      if (index % 7 === 0) {
        ctx.beginPath()
        ctx.arc(tip.x, tip.y, size * 0.38, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(255,255,255,${headFade})`
        ctx.fill()
      }
    }
    function paint(ctx, t) {
      const fill = ramp(3.05, WAITING_START_MS / 1000, t),
        dark = isDark()
      paintStars(ctx, t, dark)
      if (t < 5.1) {
        for (let i = 0; i < 3; i++) {
          const p = ramp(1.05 + i * 0.23, 3.6 + i * 0.22, t),
            m = outlines[i]
          stroke(
            ctx,
            section(m, 0, p),
            `rgba(${dark ? '113,191,255' : '26,101,176'},${0.72 * (1 - fill)})`,
            1.05
          )
        }
        ctx.save()
        ctx.clip(mark)
        ctx.globalAlpha = (1 - fill) * ramp(1.2, 2.8, t)
        for (let i = -70; i < 70; i++) {
          const yy = i * 7.2
          stroke(
            ctx,
            [
              { x: -320, y: yy - 115 },
              { x: 320, y: yy + 115 },
            ],
            dark ? (i % 3 === 0 ? '#a8d9ff' : '#3886ca') : i % 3 === 0 ? '#438ec9' : '#9cbcd9',
            i % 3 === 0 ? 0.8 : 0.45
          )
        }
        ctx.restore()
        routes.forEach((r, i) => paintComet(ctx, r, i, t, dark))
      }
      ctx.globalAlpha = 1
    }

    return paint
  }

  function paintBackdrop(context, canvas, logo, viewport, palette) {
    const { width, height } = canvas
    context.setTransform(1, 0, 0, 1, 0, 0)
    context.clearRect(0, 0, width, height)
    const glow = GLOW_MARGIN * viewport.pixelRatio
    const stableFooterTop = viewport.stableFooterTop ?? viewport.reservedFooterTop
    const belowCenter = stableFooterTop - height / 2 - glow - FOOTER_GAP * viewport.pixelRatio
    const fit = Math.max(
      0,
      Math.min(
        width / WIDTH,
        height / HEIGHT,
        (width / 2 - glow) / logo.halfWidth,
        (height / 2 - glow) / logo.halfHeight,
        belowCenter / logo.halfHeight
      )
    )
    // Status and recovery controls take precedence when they cover the full-window center.
    if (fit === 0) return false
    const offsetX = (width - WIDTH * fit) / 2
    const centeredOffsetY = (height - HEIGHT * fit) / 2
    const reservedFooterTop = viewport.reservedFooterTop ?? stableFooterTop
    const footerLimit = reservedFooterTop - LOGO_CLEARANCE * viewport.pixelRatio
    const maxOffsetY = footerLimit - (CENTER_Y + logo.halfHeight) * fit
    const minOffsetY = -(CENTER_Y - logo.halfHeight) * fit
    const offsetY = Math.max(minOffsetY, Math.min(centeredOffsetY, maxOffsetY))
    viewport.transform = { fit, offsetX, offsetY }
    context.setTransform(fit, 0, 0, fit, offsetX, offsetY)
    const aura = context.createRadialGradient(CENTER_X, CENTER_Y, 30, CENTER_X, CENTER_Y, 270)
    aura.addColorStop(0, `rgba(${palette.aura}, ${palette.auraOpacity})`)
    aura.addColorStop(1, `rgba(${palette.aura}, 0)`)
    context.fillStyle = aura
    context.fillRect(-offsetX / fit, -offsetY / fit, width / fit, height / fit)
    return true
  }

  function updateLogoMask(canvas, logo, { fit, offsetX, offsetY }) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}"><path fill="white" transform="translate(${offsetX} ${offsetY}) scale(${fit}) translate(${CENTER_X} ${CENTER_Y})" d="${logo.outline}"/></svg>`
    canvas.parentElement.style.setProperty(
      '--startup-logo-mask',
      `url("data:image/svg+xml,${encodeURIComponent(svg)}")`
    )
    const style = window.getComputedStyle(canvas.parentElement)
    const angle = (parseFloat(style.getPropertyValue('--startup-logo-angle')) * Math.PI) / 180
    const bandStart = parseFloat(style.getPropertyValue('--startup-logo-band-start')) / 100
    const bandEnd = parseFloat(style.getPropertyValue('--startup-logo-band-end')) / 100
    const gradientLength =
      2 * canvas.width * Math.sin(angle) + canvas.height * Math.abs(Math.cos(angle))
    const halfWidth = logo.halfWidth * fit
    // Clear the entire tilted light band, not just its peak, before resetting the loop.
    const tilt = (logo.halfHeight * fit * Math.abs(Math.cos(angle))) / Math.sin(angle)
    const position = (x, stop) => {
      const stopOffset = ((stop - 0.5) * gradientLength) / Math.sin(angle)
      return `${100 * (1 + (stopOffset - x) / canvas.width)}% 50%`
    }
    canvas.parentElement.style.setProperty(
      '--startup-logo-sweep-start',
      position(canvas.width / 2 - halfWidth - tilt, bandEnd)
    )
    canvas.parentElement.style.setProperty(
      '--startup-logo-sweep-end',
      position(canvas.width / 2 + halfWidth + tilt, bandStart)
    )
  }

  function createRenderer(canvas, viewport) {
    const palette = PALETTES[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark']
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The startup brand animation requires a 2D canvas')
    const logo = createLogoPath()
    const paintMeteors = createMeteorPainter(logo)
    let maskGeometry = ''
    let materialOpacity = ''
    return time => {
      if (!paintBackdrop(context, canvas, logo, viewport, palette)) {
        canvas.parentElement.style.setProperty(
          '--startup-logo-mask',
          'linear-gradient(transparent, transparent)'
        )
        delete canvas.dataset.startupLogoBounds
        maskGeometry = ''
        return
      }
      const { fit, offsetX, offsetY } = viewport.transform
      const geometry = [canvas.width, canvas.height, fit, offsetX, offsetY].join(',')
      if (geometry !== maskGeometry) {
        updateLogoMask(canvas, logo, viewport.transform)
        const ratio = viewport.pixelRatio
        const left = (offsetX + (CENTER_X - logo.halfWidth) * fit) / ratio
        const top = (offsetY + (CENTER_Y - logo.halfHeight) * fit) / ratio
        const width = (logo.halfWidth * 2 * fit) / ratio
        const height = (logo.halfHeight * 2 * fit) / ratio
        canvas.dataset.startupLogoBounds = JSON.stringify({
          left,
          top,
          right: left + width,
          bottom: top + height,
          width,
          height,
        })
        maskGeometry = geometry
      }
      const opacity = String(smooth(3.05, WAITING_START_MS / 1000, time))
      if (opacity !== materialOpacity) {
        canvas.parentElement.style.setProperty('--startup-logo-opacity', opacity)
        materialOpacity = opacity
      }
      if (time < FORMATION_DURATION_MS / 1000) {
        context.translate(CENTER_X, CENTER_Y)
        context.lineCap = 'round'
        context.lineJoin = 'round'
        paintMeteors(context, time)
      }
    }
  }

  function createStartupBrandAnimation(canvas, footerElement, footerGrowthStates = []) {
    const container = canvas.parentElement
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    const viewport = { stableFooterTop: 0, reservedFooterTop: 0, pixelRatio: 1 }
    const footerGrowthElements = [...new Set(footerGrowthStates.flat())]
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
      container.classList.toggle('is-forming', elapsed < FORMATION_DURATION_MS)
      const waiting =
        elapsed >= WAITING_START_MS &&
        !motionQuery.matches &&
        !destroyed &&
        completionPromise === null
      const wasWaiting = container.classList.contains('is-waiting-gradient')
      container.classList.toggle('is-waiting-gradient', waiting)
      if (waiting !== wasWaiting) render(elapsed / 1000)
      const resting =
        completion === null &&
        (paused() || elapsed >= FORMATION_DURATION_MS || completionPromise !== null)
      if (destroyed || resting) cancelFrame()
      else if (frameId === null) frameId = window.requestAnimationFrame(frame)
    }

    function finishCompletion() {
      const pending = completion
      completion = null
      elapsed = FORMATION_DURATION_MS
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

    // Measure transient footer states without a paint so wrapped copy and every reserved row
    // share one unobstructed baseline at the current window width and locale.
    function measureFooterTops(height, bounds) {
      const footerTop = () => {
        const footer = footerElement.getBoundingClientRect()
        return Math.max(0, Math.min(height, footer.top - bounds.top))
      }
      const previousHidden = footerGrowthElements.map(element => element.hidden)
      try {
        footerGrowthElements.forEach(element => {
          element.hidden = true
        })
        const stableFooterTop = footerTop()
        let reservedFooterTop = stableFooterTop
        footerGrowthStates.forEach(state => {
          footerGrowthElements.forEach(element => {
            element.hidden = !state.includes(element)
          })
          reservedFooterTop = Math.min(reservedFooterTop, footerTop())
        })
        return { stableFooterTop, reservedFooterTop }
      } finally {
        footerGrowthElements.forEach((element, index) => {
          element.hidden = previousHidden[index]
        })
      }
    }

    function resize() {
      if (destroyed) return
      const width = canvas.clientWidth
      const height = canvas.clientHeight
      if (!width || !height) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const nextWidth = Math.round(width * ratio)
      const nextHeight = Math.round(height * ratio)
      canvas.width = nextWidth
      canvas.height = nextHeight
      const bounds = container.getBoundingClientRect()
      const footer = footerElement.getBoundingClientRect()
      const footerTop = Math.max(0, Math.min(height, footer.top - bounds.top))
      canvas.style.maskImage = `linear-gradient(to bottom, #000 ${Math.max(0, footerTop - LOGO_CLEARANCE)}px, transparent ${footerTop}px)`
      const measured = measureFooterTops(height, bounds)
      const deviceScale = canvas.height / height
      viewport.stableFooterTop = measured.stableFooterTop * deviceScale
      viewport.reservedFooterTop = measured.reservedFooterTop * deviceScale
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
      if (container.classList.contains('is-waiting-gradient')) {
        container.style.setProperty(
          '--startup-logo-position',
          window.getComputedStyle(container, '::after').backgroundPosition
        )
      }
      cancelFrame()
      completionPromise = new Promise((resolve, reject) => {
        completion = {
          resolve,
          reject,
          formation: elapsed,
          startedAt: performance.now(),
          duration: durationMs,
        }
      })
      container.classList.remove('is-waiting-gradient')
      render(elapsed / 1000)
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
      container.classList.remove('is-waiting-gradient', 'is-forming', 'is-paused')
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
    return { setPaused, complete, destroy, refresh: resize }
  }

  window.createStartupBrandAnimation = createStartupBrandAnimation
})()
