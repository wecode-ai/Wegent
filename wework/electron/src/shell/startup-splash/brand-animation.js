;(() => {
  const WIDTH = 1200
  const HEIGHT = 680
  const CENTER_X = 600
  const CENTER_Y = 340
  const FORMATION_DURATION_MS = 5600
  const STRAND_DENSITY = 2.5
  const PLAYBACK_SPEED = 1
  const BREATHING_SCALE = 1.018
  const GLOW_MARGIN = 16
  const FOOTER_GAP = 8
  const clamp = n => Math.max(0, Math.min(1, n))
  const mix = (a, b, t) => a + (b - a) * t
  const ease = n => {
    n = clamp(n)
    return n * n * (3 - 2 * n)
  }
  const ramp = (a, b, t) => ease((t - a) / (b - a))
  const noise = n => {
    const v = Math.sin(n * 91.77 + 41.3) * 16387.31
    return v - Math.floor(v)
  }
  const isDark = () => document.documentElement.dataset.theme === 'dark'
  const source = window.WEWORK_STARTUP_BRAND_CONTOURS
  const all = source.flatMap(p => p.points)
  const center = {
    x: (Math.min(...all.map(p => p[0])) + Math.max(...all.map(p => p[0]))) / 2,
    y: (Math.min(...all.map(p => p[1])) + Math.max(...all.map(p => p[1]))) / 2,
  }
  const contours = source.map(c =>
    c.points.map(([x, y]) => ({ x: (x - center.x) * 1.12, y: (y - center.y) * 1.12 }))
  )
  function roundedPath(points, target = new Path2D()) {
    const corners = points.map((p, i) => {
      const a = points[(i + points.length - 1) % points.length],
        b = points[(i + 1) % points.length]
      const l = Math.hypot(p.x - a.x, p.y - a.y) || 1,
        r = Math.hypot(b.x - p.x, b.y - p.y) || 1,
        k = Math.min(2.8, l / 2, r / 2)
      return {
        p,
        a: { x: p.x - ((p.x - a.x) * k) / l, y: p.y - ((p.y - a.y) * k) / l },
        b: { x: p.x + ((b.x - p.x) * k) / r, y: p.y + ((b.y - p.y) * k) / r },
      }
    })
    target.moveTo(corners[0].a.x, corners[0].a.y)
    for (const { p, a, b } of corners) {
      target.lineTo(a.x, a.y)
      target.quadraticCurveTo(p.x, p.y, b.x, b.y)
    }
    target.closePath()
    return target
  }
  const mark = new Path2D()
  contours.forEach(p => roundedPath(p, mark))
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
  const sampled = contours.map((p, i) => {
    const m = measure(p, true),
      n = i === 0 ? 280 : i === 1 ? 90 : 64
    return Array.from({ length: n }, (_, j) => at(m, j / n))
  })
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

  function blue(ctx) {
    const dark = isDark(),
      g = ctx.createLinearGradient(-220, -180, 220, 210)
    g.addColorStop(0, dark ? '#74d5ff' : '#369fdf')
    g.addColorStop(0.48, dark ? '#159aff' : '#157acb')
    g.addColorStop(1, dark ? '#0873d9' : '#0860b4')
    return g
  }

  function firstContactDistance(path) {
    for (let i = 1; i < path.p.length; i++) {
      const a = path.p[i - 1],
        b = path.p[i]
      const dx = b.x - a.x,
        dy = b.y - a.y
      let contact = Infinity
      for (const contour of contours) {
        for (let j = 0; j < contour.length; j++) {
          const c = contour[j],
            d = contour[(j + 1) % contour.length]
          const ex = d.x - c.x,
            ey = d.y - c.y
          const determinant = dx * ey - dy * ex
          if (Math.abs(determinant) < 1e-8) continue
          const cx = c.x - a.x,
            cy = c.y - a.y
          const t = (cx * ey - cy * ex) / determinant
          const u = (cx * dy - cy * dx) / determinant
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) contact = Math.min(contact, t)
        }
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
    const b = { x: mix(a.x, target.x, 0.5) + v.x * curl, y: mix(a.y, target.y, 0.45) + v.y * curl },
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
        ramp(route.arrival - 48 / route.path.length, route.arrival - 14 / route.path.length, head))
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
  function drawLine(ctx, t) {
    const fill = ramp(3.05, 4.9, t),
      dark = isDark()
    paintStars(ctx, t, dark)
    ctx.globalAlpha = fill
    ctx.fillStyle = blue(ctx)
    ctx.shadowBlur = dark ? 10 : 0
    ctx.shadowColor = '#168eff'
    ctx.fill(mark)
    ctx.shadowBlur = 0
    ctx.globalAlpha = 1
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

  const smooth = ramp
  function createRenderer(canvas, viewport) {
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The startup brand animation requires a 2D canvas')
    const points = contours.flat()
    const halfWidth = (Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x))) / 2
    const halfHeight = (Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y))) / 2
    return time => {
      const { width, height } = canvas
      context.setTransform(1, 0, 0, 1, 0, 0)
      context.clearRect(0, 0, width, height)
      const glow = GLOW_MARGIN * viewport.pixelRatio
      const belowCenter = viewport.footerTop - height / 2 - glow - FOOTER_GAP * viewport.pixelRatio
      const scale = Math.max(
        0,
        Math.min(
          width / WIDTH,
          height / HEIGHT,
          (width / 2 - glow) / (halfWidth * BREATHING_SCALE),
          (height / 2 - glow) / (halfHeight * BREATHING_SCALE),
          belowCenter / (halfHeight * BREATHING_SCALE)
        )
      )
      if (scale === 0) return
      context.setTransform(
        scale,
        0,
        0,
        scale,
        (width - WIDTH * scale) / 2,
        (height - HEIGHT * scale) / 2
      )
      context.translate(CENTER_X, CENTER_Y)
      context.lineCap = 'round'
      context.lineJoin = 'round'
      drawLine(context, time)
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
