// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest'
import { readInlineVisualizationHtml } from './inlineVisualization'

const readLocalFile = vi.hoisted(() => vi.fn())

vi.mock('@/lib/electron-local-file', () => ({
  readElectronLocalFile: readLocalFile,
}))

beforeEach(() => {
  readLocalFile.mockReset()
})

describe('readInlineVisualizationHtml', () => {
  test('reads UTF-8 fragments with the visualization size limit', async () => {
    const fragment = '<section>计算器</section>'
    readLocalFile.mockResolvedValue(new TextEncoder().encode(fragment))

    await expect(readInlineVisualizationHtml('/workspace/calculator.html')).resolves.toBe(fragment)

    expect(readLocalFile).toHaveBeenCalledWith('/workspace/calculator.html', {
      maxBytes: 1024 * 1024,
    })
  })

  test('propagates size and read errors to the host error state', async () => {
    readLocalFile.mockRejectedValue(new Error('Electron local file exceeds the allowed size'))

    await expect(readInlineVisualizationHtml('/workspace/oversized.html')).rejects.toThrow(
      'Electron local file exceeds the allowed size'
    )
  })
})
