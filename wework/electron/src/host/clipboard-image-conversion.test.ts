import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { describe, expect, test, vi } from 'vitest'
import {
  MAX_CLIPBOARD_IMAGE_BYTES,
  clipboardImageToPngDataUrl,
} from './clipboard-image-conversion.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC',
  'base64'
)
const TIFF_FIXTURE = JSON.parse(
  await readFile(
    new URL('../../../e2e/desktop/fixtures/clipboard-history-image.json', import.meta.url),
    'utf8'
  )
) as { base64: string; width: number; height: number }

describe('clipboard image conversion', () => {
  test('converts a macOS clipboard file from its exact supplied bytes', async () => {
    const source = Buffer.from('source screenshot bytes')
    const runSips = vi.fn(async (inputPath: string, outputPath: string) => {
      expect(await readFile(inputPath)).toEqual(source)
      expect(inputPath.endsWith('source.tiff')).toBe(true)
      await writeFile(outputPath, PNG)
    })

    const result = await clipboardImageToPngDataUrl(
      source.toString('base64'),
      'clipboard-history.tiff',
      'image/tiff',
      { platform: 'darwin', runSips }
    )

    expect(runSips).toHaveBeenCalledOnce()
    expect(result).toBe(`data:image/png;base64,${PNG.toString('base64')}`)
  })

  test('does not run the macOS converter on other platforms', async () => {
    const runSips = vi.fn()

    await expect(
      clipboardImageToPngDataUrl('AQID', 'screenshot.tiff', 'image/tiff', {
        platform: 'win32',
        runSips,
      })
    ).resolves.toBeNull()
    expect(runSips).not.toHaveBeenCalled()
  })

  test.runIf(process.platform === 'darwin')(
    'converts a real clipboard-history TIFF with the macOS image pipeline',
    async () => {
      const result = await clipboardImageToPngDataUrl(
        TIFF_FIXTURE.base64,
        'clipboard-history.tiff',
        'image/tiff',
        { platform: 'darwin' }
      )
      assert.ok(result)
      const png = Buffer.from(result.split(',')[1], 'base64')
      expect(png.subarray(0, 8)).toEqual(PNG.subarray(0, 8))
      expect(png.readUInt32BE(16)).toBe(TIFF_FIXTURE.width)
      expect(png.readUInt32BE(20)).toBe(TIFF_FIXTURE.height)
    }
  )

  test('rejects invalid base64 and unsupported formats before conversion', async () => {
    const runSips = vi.fn()

    await expect(
      clipboardImageToPngDataUrl('not base64', 'screenshot.tiff', 'image/tiff', {
        platform: 'darwin',
        runSips,
      })
    ).resolves.toBeNull()
    await expect(
      clipboardImageToPngDataUrl(
        Buffer.alloc(MAX_CLIPBOARD_IMAGE_BYTES + 1).toString('base64'),
        'large.tiff',
        'image/tiff',
        {
          platform: 'darwin',
          runSips,
        }
      )
    ).resolves.toBeNull()
    await expect(
      clipboardImageToPngDataUrl('AQID', 'screenshot.txt', 'text/plain', {
        platform: 'darwin',
        runSips,
      })
    ).resolves.toBeNull()
    expect(runSips).not.toHaveBeenCalled()
  })
})
