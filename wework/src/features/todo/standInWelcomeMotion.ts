import {
  BufferAttribute,
  BufferGeometry,
  PerspectiveCamera,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  Vector4,
  WebGLRenderer,
} from 'three'

export type StandInWelcomeShape = 'idle' | 'connection' | 'agenda' | 'list' | 'orbit'

const pointCount = 4608
const turn = Math.PI * 2
const shapeIndex = { idle: 0, connection: 1, agenda: 2, list: 3, orbit: 4 }
const transitionMs = 1150
const wakeCount = 4
const fract = (value: number) => value - Math.floor(value)

function sample(shape: StandInWelcomeShape, index: number) {
  const angle = turn * fract(index * 0.61803398875)
  const offset = fract(index * 0.754877666) - 0.5
  const section = index % 6
  const spin = turn * fract(index * 0.414213562)
  if (shape === 'connection') {
    const lane = index % 3
    if (lane === 1) {
      const x = offset * 1.9
      const radius = 0.09 + 0.1 * Math.sin(x * Math.PI)
      return [x, radius * Math.sin(angle + x * 8), radius * Math.cos(angle + x * 8)]
    }
    const radius = 0.57 + 0.13 * Math.cos(spin)
    return [
      (lane - 1) * 1.21 + radius * Math.cos(angle),
      radius * Math.sin(angle),
      0.15 * Math.sin(spin) + 0.25 * Math.sin(angle),
    ]
  }
  if (shape === 'agenda') {
    const edge = angle / (Math.PI / 2)
    const along = fract(edge) - 0.5
    const side = Math.floor(edge)
    const cross = 0.38 + offset * 0.12
    const x = side % 2 === 0 ? along * 0.76 : side === 1 ? cross : -cross
    const y = side % 2 === 0 ? (side === 0 ? cross : -cross) : along * 0.76
    return [
      x + ((section % 3) - 1) * 1.02,
      y + (0.5 - Math.floor(section / 3)) * 1.04,
      0.13 * Math.sin(spin),
    ]
  }
  if (shape === 'list') {
    const x = offset * (2.55 - section * 0.11) - 0.03 * section
    return [x, (2.5 - section) * 0.31 + 0.075 * Math.sin(angle), 0.11 * Math.cos(angle)]
  }
  if (shape === 'orbit') {
    const orbit = index % 4
    const radius = 0.64 + 0.27 * orbit + 0.06 * Math.cos(spin)
    const inclination = (orbit - 1.5) * 0.39
    return [
      radius * Math.cos(angle),
      radius * Math.sin(angle) * Math.cos(inclination) * 0.71,
      radius * Math.sin(angle) * Math.sin(inclination) + 0.1 * Math.sin(spin),
    ]
  }

  const strand = (section + offset * 0.75) * (turn / 6)
  const twist = angle * 2 + strand
  const radius = 1.24 + 0.3 * Math.cos(twist) + 0.14 * offset
  return [
    radius * Math.cos(angle),
    (0.76 * Math.sin(angle) + 0.35 * Math.sin(twist)) * (1 + offset * 0.23),
    radius * Math.sin(angle) * 0.67 + 0.31 * Math.cos(twist) + 0.1 * Math.sin(spin),
  ]
}

const vertexShader = /* glsl */ `
  attribute vec3 destination;
  attribute float seed;

  uniform float time;
  uniform float morph;
  uniform float dispersion;
  uniform vec4 shapeWeights;
  uniform float pixelRatio;
  uniform float viewportHeight;
  uniform float viewportAspect;
  uniform vec4 pointerWakes[${wakeCount}];
  uniform vec4 pointerStrength;

  varying float glow;
  varying float depth;
  varying float density;

  vec3 shapeMotion(vec3 p, float shape, out float light) {
    float sweep = sin(time * 1.6 - p.x * 2.8 + p.y * .65);
    if (shape < .5) {
      float turn = .32 + sin(time * .37) * .45;
      p.xz = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xz;
      p.y += .12 * sin(p.x * 2.6 + time);
      light = .5 + .5 * sin(p.x * 3.6 + p.z * 3.2 - time * 1.65);
    } else if (shape < 1.5) {
      p.y += .04 * sin(p.x * 6.0 - time * 2.8);
      float pulse = fract((time - p.x * .58) * .38) - .5;
      light = exp(-pulse * pulse * 34.0);
    } else if (shape < 2.5) {
      float pulse = fract(time * .34 - p.x * .24 + p.y * .23) - .48;
      light = exp(-pulse * pulse * 38.0);
    } else if (shape < 3.5) {
      p.y += .037 * sweep;
      light = pow(.5 + .5 * sweep, 4.0);
    } else {
      float turn = time * .12;
      p.xy = mat2(cos(turn), -sin(turn), sin(turn), cos(turn)) * p.xy;
      light = .5 + .5 * sin(time * 2.3 - atan(p.y, p.x) * 3.0 + p.z * 4.0);
    }

    return p;
  }

  void main() {
    vec3 p = mix(position, destination, morph);
    vec3 wave = sin(p.yzx * 4.2 + p.zxy * 2.8 + time * vec3(.8, .6, .75));
    p += wave * (.027 + .2 * dispersion);

    vec3 posed = vec3(0.0);
    glow = 0.0;
    float idleWeight = max(0.0, 1.0 - dot(shapeWeights, vec4(1.0)));
    if (idleWeight > 0.0001) {
      float light;
      posed += shapeMotion(p, 0.0, light) * idleWeight;
      glow += light * idleWeight;
    }
    for (int shape = 0; shape < 4; shape++) {
      float weight = shapeWeights[shape];
      if (weight > 0.0001) {
        float light;
        posed += shapeMotion(p, float(shape) + 1.0, light) * weight;
        glow += light * weight;
      }
    }
    p = posed;
    vec4 view = modelViewMatrix * vec4(p, 1.0);
    vec4 clip = projectionMatrix * view;
    vec2 projected = clip.xy / clip.w * vec2(viewportAspect, 1.0);
    vec2 pluck = vec2(0.0);
    for (int index = 0; index < ${wakeCount}; index++) {
      float strength = pointerStrength[index];
      if (abs(strength) < .002) continue;
      vec4 wake = pointerWakes[index];
      vec2 delta = projected - wake.xy;
      vec2 flow = wake.zw;
      vec2 side = vec2(-flow.y, flow.x);
      float along = (dot(delta, flow) + .023) / .19;
      float across = dot(delta, side) / .13;
      float reach = exp(-2.2 * (along * along + across * across));
      float sideways = (smoothstep(-1.0, 1.0, across) * 2.0 - 1.0) * .009;
      float flutter = mix(.58, 1.22, seed);
      pluck += (flow * .042 + side * sideways) * reach * strength * flutter;
    }
    view.xy += pluck * (-view.z / projectionMatrix[1][1]);
    gl_Position = projectionMatrix * view;
    depth = smoothstep(-1.15, 1.05, p.z);
    density = seed;
    float size = mix(1.45, 2.82, depth) * mix(.64, 1.34, seed);
    gl_PointSize = pixelRatio * size * clamp(viewportHeight / 245.0, .72, 1.53);
  }
`

const fragmentShader = /* glsl */ `
  varying float glow;
  varying float depth;
  varying float density;

  void main() {
    vec2 uv = gl_PointCoord - vec2(.5);
    float distanceToCenter = length(uv) * 2.0;
    float softEdge = 1.0 - smoothstep(.18, 1.0, distanceToCenter);
    float core = 1.0 - smoothstep(.05, .43, distanceToCenter);
    vec3 cobalt = vec3(.22, .30, .79);
    vec3 periwinkle = vec3(.46, .55, .97);
    vec3 highlight = vec3(.42, .70, 1.0);
    vec3 color = mix(cobalt, periwinkle, depth);
    color = mix(color, highlight, glow * .48 + density * .15);
    float opacity = mix(.47, .87, depth) * (.71 + glow * .29);
    gl_FragColor = vec4(mix(color, highlight, core * glow * .36), softEdge * opacity);
  }
`

function writeShape(array: Float32Array, shape: StandInWelcomeShape) {
  for (let index = 0; index < pointCount; index += 1) array.set(sample(shape, index), index * 3)
}

export function animateStandInWelcome(
  canvas: HTMLCanvasElement,
  getShape: () => StandInWelcomeShape
) {
  const context = canvas.getContext('webgl2', { alpha: true, antialias: false })
  if (!context) return

  const renderer = new WebGLRenderer({ canvas, context, alpha: true, antialias: false })
  const camera = new PerspectiveCamera(33, 1, 0.1, 20)
  const scene = new Scene()
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const pixelRatio = Math.min(window.devicePixelRatio, 2)
  renderer.setPixelRatio(pixelRatio)

  const start = new Float32Array(pointCount * 3)
  const end = new Float32Array(pointCount * 3)
  let shape = getShape()
  writeShape(start, shape)
  end.set(start)
  const origin = new BufferAttribute(start, 3)
  const destination = new BufferAttribute(end, 3)
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', origin)
  geometry.setAttribute('destination', destination)
  geometry.setAttribute(
    'seed',
    new BufferAttribute(
      Float32Array.from({ length: pointCount }, (_, index) => fract(index * 0.73205)),
      1
    )
  )

  const endWeights = new Vector4(0, 0, 0, 0)
  const setEndWeights = (shape: StandInWelcomeShape) => {
    endWeights.set(0, 0, 0, 0)
    if (shape !== 'idle') endWeights.setComponent(shapeIndex[shape] - 1, 1)
  }
  setEndWeights(shape)
  const startWeights = endWeights.clone()
  const pointerWakes = Array.from({ length: wakeCount }, () => new Vector4())
  const wakeTimes = Array.from({ length: wakeCount }, () => -Infinity)
  const uniforms = {
    time: { value: 0 },
    morph: { value: 1 },
    dispersion: { value: 0 },
    shapeWeights: { value: startWeights.clone() },
    viewportHeight: { value: 1 },
    pixelRatio: { value: pixelRatio },
    viewportAspect: { value: 1 },
    pointerWakes: { value: pointerWakes },
    pointerStrength: { value: new Vector4(0, 0, 0, 0) },
  }
  const material = new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
  const cloud = new Points(geometry, material)
  cloud.frustumCulled = false
  scene.add(cloud)

  let frame = 0
  let changedAt = -transitionMs
  const openedAt = performance.now()
  let lastFrameAt = openedAt
  const lastPointer = new Vector2()
  let lastPointerTime = -Infinity
  let nextWake = 0

  const draw = (now: number) => {
    const nextShape = getShape()
    if (shape !== nextShape) {
      const previousProgress = uniforms.morph.value
      for (let index = 0; index < start.length; index += 1) {
        start[index] += (end[index] - start[index]) * previousProgress
      }
      writeShape(end, nextShape)
      origin.needsUpdate = true
      destination.needsUpdate = true
      startWeights.copy(uniforms.shapeWeights.value)
      setEndWeights(nextShape)
      delete canvas.dataset.renderedShape
      shape = nextShape
      changedAt = now
    }

    const progress = reducedMotion.matches ? 1 : Math.min((now - changedAt) / transitionMs, 1)
    uniforms.morph.value = progress * progress * (3 - 2 * progress)
    uniforms.shapeWeights.value.lerpVectors(startWeights, endWeights, uniforms.morph.value)
    const impact = 1 - Math.abs(2 * uniforms.morph.value - 1)
    const elapsed = Math.max(0, now - lastFrameAt)
    lastFrameAt = now
    uniforms.dispersion.value = reducedMotion.matches
      ? 0
      : uniforms.dispersion.value +
        (impact - uniforms.dispersion.value) * (1 - Math.exp(-elapsed / 125))
    uniforms.time.value = reducedMotion.matches ? 0 : (now - openedAt) / 1000
    for (let index = 0; index < wakeCount; index += 1) {
      const age = now - wakeTimes[index]
      const strength =
        reducedMotion.matches || age >= 800 ? 0 : Math.min(age / 48, 1) * Math.exp(-age / 205)
      uniforms.pointerStrength.value.setComponent(index, strength)
    }
    renderer.render(scene, camera)
    if (
      progress === 1 &&
      uniforms.dispersion.value < 0.015 &&
      canvas.dataset.renderedShape !== shape
    ) {
      canvas.dataset.renderedShape = shape
    }
    if (!document.hidden && !reducedMotion.matches) frame = requestAnimationFrame(draw)
  }

  const resume = () => {
    cancelAnimationFrame(frame)
    if (!document.hidden) frame = requestAnimationFrame(draw)
  }
  const observer = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect
    if (!width || !height) return
    renderer.setSize(width, height, false)
    camera.aspect = width / height
    uniforms.viewportAspect.value = camera.aspect
    camera.position.z = Math.max(6.05, 8 / camera.aspect)
    camera.updateProjectionMatrix()
    uniforms.viewportHeight.value = height
    resume()
  })
  const movePointer = (event: PointerEvent) => {
    if (reducedMotion.matches || event.pointerType === 'touch') return
    const bounds = canvas.getBoundingClientRect()
    const now = performance.now()
    const x = (2 * (event.clientX - bounds.left) - bounds.width) / bounds.height
    const y = 1 - (2 * (event.clientY - bounds.top)) / bounds.height
    const fresh = now - lastPointerTime > 140
    if (fresh) {
      lastPointer.set(x, y)
      lastPointerTime = now
      return
    }
    const dx = x - lastPointer.x
    const dy = y - lastPointer.y
    const distance = Math.hypot(dx, dy)
    if (now - lastPointerTime < 36 || distance < 0.022) return

    pointerWakes[nextWake].set(x, y, dx / distance, dy / distance)
    wakeTimes[nextWake] = now
    nextWake = (nextWake + 1) % wakeCount
    lastPointer.set(x, y)
    lastPointerTime = now
  }
  const resetPointer = () => {
    lastPointerTime = -Infinity
  }
  observer.observe(canvas)
  canvas.addEventListener('pointermove', movePointer)
  canvas.addEventListener('pointerleave', resetPointer)
  document.addEventListener('visibilitychange', resume)
  reducedMotion.addEventListener('change', resume)

  return {
    redraw: resume,
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      delete canvas.dataset.renderedShape
      canvas.removeEventListener('pointermove', movePointer)
      canvas.removeEventListener('pointerleave', resetPointer)
      document.removeEventListener('visibilitychange', resume)
      reducedMotion.removeEventListener('change', resume)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
    },
  }
}
