import { developmentBuildInputs } from './development-build-inputs.mjs'
import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'

test('ignores delayed startup notifications and duplicate events but detects input edits', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'build-inputs-'))
  const source = path.join(root, 'entry.js')
  try {
    await writeFile(source, 'initial')
    const changed = developmentBuildInputs({
      directories: [root],
      files: [],
      excluded: () => false,
    })
    expect(changed(source, root)).toBe(false)
    expect(changed(root, root)).toBe(false)
    await writeFile(source, 'updated input')
    expect(changed(source, root)).toBe(true)
    expect(changed(source, root)).toBe(false)
    await rm(source)
    expect(changed(source, root)).toBe(true)
    expect(changed(source, root)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detects directory moves and new sources while excluding emitted output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'build-inputs-directory-'))
  const original = path.join(root, 'original')
  const moved = path.join(root, 'moved')
  const output = path.join(root, 'output')
  try {
    await mkdir(original)
    await writeFile(path.join(original, 'entry.js'), 'one')
    const changed = developmentBuildInputs({
      directories: [root],
      files: [],
      excluded: filename => filename.startsWith(output),
    })
    await rename(original, moved)
    expect(changed(original, root)).toBe(true)
    expect(changed(moved, root)).toBe(true)
    expect(changed(moved, root)).toBe(false)
    await mkdir(output)
    await writeFile(path.join(output, 'bundle.js'), 'emitted')
    expect(changed(output, root)).toBe(false)
    await writeFile(path.join(moved, 'another.js'), 'two')
    expect(changed(moved, root)).toBe(true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test.each(['deleted', 'replaced'])(
  'records a directory %s between stat and traversal',
  async outcome => {
    const root = await mkdtemp(path.join(tmpdir(), 'build-inputs-race-'))
    const directory = path.join(root, 'source')
    try {
      await mkdir(directory)
      await writeFile(path.join(directory, 'entry.js'), 'original')
      let mutateOnRead = false
      const changed = developmentBuildInputs({
        directories: [root],
        files: [],
        excluded: () => false,
        readDirectory: filename => {
          if (mutateOnRead && filename === directory) {
            mutateOnRead = false
            rmSync(directory, { recursive: true })
            if (outcome === 'replaced') writeFileSync(directory, 'replacement file')
          }
          return readdirSync(filename)
        },
      })
      mutateOnRead = true
      expect(changed(directory, root)).toBe(true)
      expect(mutateOnRead).toBe(false)
      expect(changed(directory, root)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)

test('tracks a file replaced by a directory instead of using the single-file path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'build-inputs-type-'))
  const source = path.join(root, 'source')
  try {
    await writeFile(source, 'original')
    const changed = developmentBuildInputs({
      directories: [root],
      files: [],
      excluded: () => false,
    })
    await rm(source)
    await mkdir(source)
    await writeFile(path.join(source, 'entry.js'), 'replacement')
    expect(changed(source, root)).toBe(true)
    expect(changed(source, root)).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
