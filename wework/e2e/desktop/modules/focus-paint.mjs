// This function is serialized and runs in the actual Electron renderer.
export function readFocusPaint(element) {
  const style = getComputedStyle(element)
  const backgrounds = [style.backgroundColor]
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const color = getComputedStyle(parent).backgroundColor
    if (color !== 'rgba(0, 0, 0, 0)') backgrounds.push(color)
    if (color.startsWith('rgb(')) break
  }
  return {
    visible: element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
    shadow: style.boxShadow,
    outlineStyle: style.outlineStyle,
    outlineWidth: style.outlineWidth,
    outlineColor: style.outlineColor,
    outlineOffset: style.outlineOffset,
    offsetShadow: style.getPropertyValue('--tw-ring-offset-shadow').trim(),
    borders: ['Top', 'Right', 'Bottom', 'Left'].map(side => ({
      width: parseFloat(style[`border${side}Width`]),
      color: style[`border${side}Color`],
    })),
    backgrounds,
  }
}

export function colorChannels(value) {
  if (value === 'transparent') return [0, 0, 0, 0]
  if (value.startsWith('#')) {
    let hex = value.slice(1)
    if (hex.length < 5) hex = [...hex].map(channel => channel.repeat(2)).join('')
    const channels = hex.match(/../g).map(pair => parseInt(pair, 16))
    return [...channels.slice(0, 3), (channels[3] ?? 255) / 255]
  }
  const parts = value.match(/^(rgba?|color)\((?:srgb\s+)?(.*)\)$/)
  if (!parts || /[a-df-z]/i.test(parts[2])) {
    throw new Error(`Expected a computed sRGB color, received ${value}`)
  }
  const [r, g, b, alpha = '1'] = parts[2].split(/[\s,/]+/)
  const scale = parts[1] === 'color' ? 255 : 1
  return [
    ...[r, g, b].map(channel =>
      channel.endsWith('%') ? (parseFloat(channel) * 255) / 100 : Number(channel) * scale
    ),
    alpha.endsWith('%') ? parseFloat(alpha) / 100 : Number(alpha),
  ]
}

function over(foreground, opaqueBackground) {
  return opaqueBackground.map(
    (channel, index) => foreground[index] * foreground[3] + channel * (1 - foreground[3])
  )
}

function shadowBand(shadow) {
  const tokens = shadow.match(/[a-z-]+\([^()]*\)|[^\s]+/gi) ?? []
  const lengths = tokens.filter(token => /^-?(?:[\d.]+px|0)$/.test(token)).map(parseFloat)
  const [x, y, blur = 0, spread = 0] = lengths
  // Elevation shadows have an offset or blur. Only a positive concentric spread paints a ring.
  if (x !== 0 || y !== 0 || blur !== 0 || spread <= 0) return null
  const color = tokens.find(token => token !== 'inset' && !/^-?[\d.]/.test(token))
  const inset = tokens.includes('inset')
  return { from: inset ? -spread : 0, to: inset ? 0 : spread, color: colorChannels(color) }
}

function paintBands(style, { width, color }) {
  const bands = style.shadow
    .split(/,(?![^(]*\))/)
    .map(shadowBand)
    .filter(Boolean)
  // Tailwind paints the offset as a separate shadow in front of the outside ring.
  const offset = shadowBand(style.offsetShadow)
  if (offset) {
    const spacer = bands.find(
      band =>
        band.from === offset.from &&
        band.to === offset.to &&
        band.color.every((v, i) => v === offset.color[i])
    )
    if (spacer) spacer.spacer = true
  }
  // Inset shadows start at the padding edge. The border occupies the strip up to the outer edge.
  if (width > 0) {
    for (const band of bands) {
      if (band.from < 0) {
        band.from -= width
        band.to -= width
      }
    }
    bands.unshift({ from: -width, to: 0, color: colorChannels(color) })
  }
  if (!['none', 'hidden'].includes(style.outlineStyle) && parseFloat(style.outlineWidth) > 0) {
    const from = parseFloat(style.outlineOffset)
    bands.unshift({
      from,
      to: from + parseFloat(style.outlineWidth),
      color: colorChannels(style.outlineColor),
    })
  }
  return bands.filter(band => band.color[3] > 0)
}

const pixel = channels => channels.map(Math.round).join(',')

function sample(bands, distance, background) {
  let color = background
  let indicator = false
  // CSS paints the first shadow on top. A wide opaque ring can hide smaller rings behind it.
  for (const band of bands.toReversed()) {
    if (distance < band.from || distance >= band.to) continue
    color = over(band.color, color)
    indicator = !band.spacer
  }
  return { color: pixel(color), indicator: indicator && pixel(color) !== pixel(background) }
}

function countChangedBands(active, rest, inside, outside) {
  const edges = [
    ...new Set([0, ...[...active, ...rest].flatMap(band => [band.from, band.to])]),
  ].sort((a, b) => a - b)
  let count = 0
  let previous = null
  for (let i = 1; i < edges.length; i++) {
    const distance = (edges[i] + edges[i - 1]) / 2
    const background = distance < 0 ? inside : outside
    const now = sample(active, distance, background)
    const before = sample(rest, distance, background)
    const changed = now.indicator && before.color !== now.color ? now.color : null
    if (changed !== null && changed !== previous) count++
    previous = changed
  }
  return count
}

export function focusLayers(focused, unfocused) {
  if (!focused.visible) return 0
  if (!unfocused?.visible)
    throw new Error('A visible unfocused baseline from the same control is required')
  const [surface, ...ancestors] = focused.backgrounds.map(colorChannels)
  const outside = ancestors.toReversed().reduce((bg, color) => over(color, bg), [255, 255, 255])
  const inside = over(surface, outside)
  // A complete border is one band. A single highlighted edge can still expose a second band.
  return Math.max(
    ...focused.borders.map((border, side) =>
      countChangedBands(
        paintBands(focused, border),
        paintBands(unfocused, unfocused.borders[side]),
        inside,
        outside
      )
    )
  )
}
