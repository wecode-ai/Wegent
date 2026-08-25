import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { isGeneratedLocalFilePreview, prepareLocalFileNavigation } from './local-file-preview.js'

describe('prepareLocalFileNavigation', () => {
  test('renders a directory index and preserves the requested URL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-directory-preview-'))
    await mkdir(join(directory, 'nested'))
    await writeFile(join(directory, 'readme.txt'), 'fixture', 'utf8')
    const sourceUrl = pathToFileURL(directory).href

    const result = await prepareLocalFileNavigation(sourceUrl)

    expect(result).toMatchObject({ kind: 'preview', sourceUrl })
    if (result.kind !== 'preview') throw new Error('Expected a directory preview')
    expect(isGeneratedLocalFilePreview(result.displayUrl)).toBe(true)
    expect(fileURLToPath(result.displayUrl)).not.toBe(directory)
  })

  test('blocks archive navigation so the workbench can show a notice', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-file-preview-'))
    const archive = join(directory, 'fixture.zip')
    await writeFile(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04]))

    await expect(prepareLocalFileNavigation(pathToFileURL(archive).href)).resolves.toEqual({
      kind: 'blocked',
      sourceUrl: pathToFileURL(archive).href,
    })
  })

  test('leaves native HTML rendering unchanged', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-file-preview-'))
    const html = join(directory, 'fixture.html')
    await writeFile(html, '<h1>fixture</h1>', 'utf8')
    const sourceUrl = pathToFileURL(html).href

    await expect(prepareLocalFileNavigation(sourceUrl)).resolves.toEqual({
      kind: 'direct',
      displayUrl: sourceUrl,
      sourceUrl,
    })
  })
})
