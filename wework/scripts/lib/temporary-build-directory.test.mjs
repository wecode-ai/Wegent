import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { withTemporaryBuildDirectory } from './temporary-build-directory.mjs'

test('waits for pending writers before cleaning a failed parallel build', async () => {
  let directory
  let release
  let writingFinished = false
  const blocked = new Promise(resolve => {
    release = resolve
  })
  const consume = vi.fn()
  const pending = withTemporaryBuildDirectory({
    prefix: 'wework-build-failure-',
    builds: [
      output => {
        directory = output
        throw new Error('compile failed')
      },
      async output => {
        await blocked
        await writeFile(join(output, 'asset.js'), 'complete')
        writingFinished = true
      },
    ],
    consume,
  })
  await expect.poll(() => directory).toBeTruthy()
  await expect(access(directory)).resolves.toBeUndefined()
  expect(writingFinished).toBe(false)
  const failure = expect(pending).rejects.toThrow('compile failed')
  release()
  await failure
  expect(writingFinished).toBe(true)
  expect(consume).not.toHaveBeenCalled()
  await expect(access(directory)).rejects.toThrow()
})

test.each([false, true])('cleans temporary output after copying (failure=%s)', async failCopy => {
  const destination = await mkdtemp(join(tmpdir(), 'wework-build-destination-'))
  let directory
  try {
    const pending = withTemporaryBuildDirectory({
      prefix: 'wework-build-copy-',
      builds: [
        async output => {
          directory = output
          await writeFile(join(output, 'asset.js'), 'complete')
          return 'build-result'
        },
      ],
      consume: async ([result], output) => {
        expect(result).toBe('build-result')
        const content = await readFile(join(output, 'asset.js'), 'utf8')
        if (failCopy) throw new Error('copy failed')
        await writeFile(join(destination, 'asset.js'), content)
        return content
      },
    })
    if (failCopy) await expect(pending).rejects.toThrow('copy failed')
    else {
      await expect(pending).resolves.toBe('complete')
      expect(await readFile(join(destination, 'asset.js'), 'utf8')).toBe('complete')
    }
    await expect(access(directory)).rejects.toThrow()
  } finally {
    await rm(destination, { recursive: true, force: true })
  }
})
