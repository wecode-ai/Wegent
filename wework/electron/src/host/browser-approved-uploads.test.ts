import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, test } from 'vitest'
import { BrowserApprovedUploads, uploadFileIdentity } from './browser-approved-uploads.js'

async function approvedFile(realPath: string) {
  const identity = await stat(realPath, { bigint: true })
  return { realPath, fileIdentity: uploadFileIdentity(identity), size: identity.size }
}

test.each(['approved fixture', ''])(
  'retains the approved bytes through later source edits (contents=%j)',
  async content => {
    const directory = await mkdtemp(join(tmpdir(), 'wework-approved-upload-test-'))
    const store = new BrowserApprovedUploads(directory)
    try {
      const source = join(directory, 'fixture.txt')
      await writeFile(source, content)
      const approved = await approvedFile(source)
      const snapshot = await store.create(approved, new AbortController().signal)
      expect(basename(snapshot.path)).toBe('fixture.txt')
      await writeFile(source, 'different source')
      expect(await readFile(snapshot.path, 'utf8')).toBe(content)
      await store.stop()
      await expect(stat(snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await store.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test('rejects a changed source before copying and cleans discarded or cancelled snapshots', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wework-approved-upload-test-'))
  const store = new BrowserApprovedUploads(directory)
  try {
    const source = join(directory, 'fixture.txt')
    await writeFile(source, 'initial')
    const before = await approvedFile(source)
    await writeFile(source, 'changed bytes')
    await expect(store.create(before, new AbortController().signal)).rejects.toMatchObject({
      code: 'approval_target_changed',
    })
    expect(await readdir(directory)).toEqual(['fixture.txt'])
    const current = await approvedFile(source)
    const snapshot = await store.create(current, new AbortController().signal)
    await snapshot.discard()
    await expect(stat(snapshot.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const cancelled = store.create(current, new AbortController().signal)
    const stopped = store.stop()
    await expect(cancelled).rejects.toThrow()
    await stopped
    expect(await readdir(directory)).toEqual(['fixture.txt'])
  } finally {
    await store.stop()
    await rm(directory, { recursive: true, force: true })
  }
})
