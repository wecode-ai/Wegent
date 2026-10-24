import { mkdtemp, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { developmentBuildInputs } from './development-build-inputs.mjs'

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
