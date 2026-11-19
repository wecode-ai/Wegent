import assert from 'node:assert/strict'

/** Read actual painted layers from outermost to innermost, including alpha. */
export async function assertReadableSurface(
  control,
  background,
  foreground = background,
  underlays = []
) {
  const read = async (selector, value) => {
    const channels = (await control.command('getStyle', selector, { value }))
      .match(/[\d.]+/g)
      ?.map(Number)
    assert.ok(channels?.length >= 3, `Expected RGB ${value} for ${selector}`)
    return channels
  }
  const blend = (color, surface) =>
    color
      .slice(0, 3)
      .map((channel, index) => channel * (color[3] ?? 1) + surface[index] * (1 - (color[3] ?? 1)))
  let surface
  for (const selector of [...underlays, background]) {
    const color = await read(selector, 'background-color')
    if ((color[3] ?? 1) === 1) surface = color.slice(0, 3)
    else {
      assert.ok(surface, 'Contrast requires its actual opaque background before translucent layers')
      surface = blend(color, surface)
    }
  }
  const color = blend(await read(foreground, 'color'), surface)
  const luminance = channels =>
    channels.reduce((sum, channel, index) => {
      const value = channel / 255
      return (
        sum +
        (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][index]
      )
    }, 0)
  const text = luminance(color)
  const fill = luminance(surface)
  const ratio = (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05)
  assert.ok(ratio >= 4.5, `Text needs 4.5:1 contrast: ${foreground} on ${background}: ${ratio}`)
}
