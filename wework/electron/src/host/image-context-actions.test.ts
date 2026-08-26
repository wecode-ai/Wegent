import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  cleanupStaleTemporaryImages,
  materializeTemporaryImage,
  resolveRendererImageContext,
  scheduleTemporaryImageCleanup,
} from './image-context-actions.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { force: true, recursive: true }))
  )
})

describe('resolveRendererImageContext', () => {
  test('returns validated renderer metadata for a local image', async () => {
    const executeJavaScript = vi.fn(async () => ({
      filename: '../preview.png',
      localPath: '/tmp/source.png',
      sourceUrl: 'blob:preview',
    }))
    const contents = { executeJavaScript } as unknown as WebContents

    await expect(
      resolveRendererImageContext(contents, {
        mediaType: 'image',
        selectionText: '',
        x: 120,
        y: 240,
      })
    ).resolves.toEqual({
      filename: 'preview.png',
      localPath: '/tmp/source.png',
      sourceUrl: 'blob:preview',
    })
    expect(executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('elementFromPoint'),
      true
    )
  })

  test('discards a renderer-provided relative local path', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => ({
        filename: 'preview.png',
        localPath: '../source.png',
        sourceUrl: 'blob:preview',
      })),
    } as unknown as WebContents

    await expect(
      resolveRendererImageContext(contents, {
        mediaType: 'image',
        selectionText: '',
        x: 1,
        y: 2,
      })
    ).resolves.toMatchObject({ localPath: null })
  })
})

describe('materializeTemporaryImage', () => {
  test('writes the original remote image bytes to a temporary file', async () => {
    const bytes = Buffer.from('remote-image')
    const contents = {
      executeJavaScript: vi.fn(async () => `data:image/png;base64,${bytes.toString('base64')}`),
    } as unknown as WebContents

    const path = await materializeTemporaryImage(contents, {
      filename: 'remote.png',
      localPath: null,
      sourceUrl: 'blob:remote',
    })
    temporaryDirectories.push(dirname(path))

    expect(path).toMatch(/remote\.png$/)
    await expect(readFile(path)).resolves.toEqual(bytes)
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('response.body.getReader()'),
      true
    )
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining('totalBytes > 104857600'),
      true
    )
  })

  test('adds an extension from the MIME type when the filename has none', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => 'data:image/webp;base64,aW1hZ2U='),
    } as unknown as WebContents

    const path = await materializeTemporaryImage(contents, {
      filename: 'remote',
      localPath: null,
      sourceUrl: 'blob:remote',
    })
    temporaryDirectories.push(dirname(path))

    expect(path).toMatch(/remote\.webp$/)
  })

  test('removes a materialized image after the cleanup delay', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
    } as unknown as WebContents
    const path = await materializeTemporaryImage(contents, {
      filename: 'remote.png',
      localPath: null,
      sourceUrl: 'blob:remote',
    })
    temporaryDirectories.push(dirname(path))

    scheduleTemporaryImageCleanup(path, 0)

    await vi.waitFor(async () => {
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  test('removes stale managed temporary image directories', async () => {
    const contents = {
      executeJavaScript: vi.fn(async () => 'data:image/png;base64,aW1hZ2U='),
    } as unknown as WebContents
    const path = await materializeTemporaryImage(contents, {
      filename: 'remote.png',
      localPath: null,
      sourceUrl: 'blob:remote',
    })
    temporaryDirectories.push(dirname(path))

    await cleanupStaleTemporaryImages(0, Date.now() + 1_000)

    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
