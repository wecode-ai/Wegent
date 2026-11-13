import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function readNormalizedEdgeMean(imagePath, rect) {
  assert.ok(imagePath, 'Image edge evidence requires a screenshot path')
  assert.ok(
    rect &&
      Number.isFinite(rect.left) &&
      Number.isFinite(rect.top) &&
      Number.isFinite(rect.width) &&
      Number.isFinite(rect.height),
    `Image edge evidence requires a finite rectangle, received ${JSON.stringify(rect)}`
  )

  const width = Math.max(1, Math.round(rect.width))
  const height = Math.max(1, Math.round(rect.height))
  const left = Math.round(rect.left)
  const top = Math.round(rect.top)
  const geometry = `${width}x${height}+${left}+${top}`
  // Linux E2E images include ImageMagick because screenshot capture uses import.
  const { stdout } = await execFileAsync(
    'convert',
    [
      imagePath,
      '-crop',
      geometry,
      '+repage',
      '-colorspace',
      'Gray',
      '-normalize',
      '-edge',
      '1',
      '-format',
      '%[fx:mean]',
      'info:',
    ],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 }
  )
  const value = Number.parseFloat(stdout)
  assert.ok(Number.isFinite(value), `Invalid edge energy for ${imagePath}: ${stdout}`)
  return { value, geometry }
}

export async function assertRegionBlurred({ beforePath, afterPath, rect, label, maxRatio = 0.7 }) {
  if (process.platform !== 'linux') return null
  if (!beforePath || !afterPath) return null

  // Normalization removes the scrim's brightness change. A sharp icon keeps its
  // edge energy under that scrim; a blurred icon spreads the same edges instead.
  const before = await readNormalizedEdgeMean(beforePath, rect)
  const after = await readNormalizedEdgeMean(afterPath, rect)
  const ratio = after.value / before.value
  assert.ok(
    before.value > 0.01,
    `${label} has no measurable edge energy before the overlay: ${JSON.stringify({
      before: before.value,
      geometry: before.geometry,
    })}`
  )
  assert.ok(
    ratio < maxRatio,
    `${label} remained sharp behind the overlay: ${JSON.stringify({
      before: before.value,
      after: after.value,
      ratio,
      maxRatio,
      geometry: before.geometry,
    })}`
  )
  return { before: before.value, after: after.value, ratio, geometry: before.geometry }
}
