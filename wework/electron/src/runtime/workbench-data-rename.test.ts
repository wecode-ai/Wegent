import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { renameWorkbenchData } from './workbench-data-rename.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
let source: string
let target: string
beforeEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  root = fs.mkdtempSync(join(tmpdir(), 'migration-rename-'))
  source = join(root, 'pending.json')
  target = join(root, 'journal.json')
  fs.writeFileSync(source, 'completed')
  fs.writeFileSync(target, 'pending')
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

test.each(['EPERM', 'EACCES', 'EBUSY'])(
  'completes an atomic journal replacement after a temporary Windows %s error',
  code => {
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('temporarily locked'), { code })
    })
    renameWorkbenchData(source, target, 'win32')
    expect(fs.readFileSync(target, 'utf8')).toBe('completed')
    expect(fs.existsSync(source)).toBe(false)
  }
)

test('reports a persistent Windows lock and preserves both files', () => {
  const failure = Object.assign(new Error('still locked'), { code: 'EPERM' })
  vi.mocked(fs.renameSync).mockImplementation(() => {
    throw failure
  })
  let time = 0
  vi.spyOn(Date, 'now').mockImplementation(() => time)
  vi.spyOn(Atomics, 'wait').mockImplementation((_array, _index, _value, timeout) => {
    time += timeout ?? 0
    return 'timed-out'
  })
  expect(() => renameWorkbenchData(source, target, 'win32')).toThrow(failure)
  expect(time).toBe(2_000)
  expect(fs.readFileSync(source, 'utf8')).toBe('completed')
  expect(fs.readFileSync(target, 'utf8')).toBe('pending')
})

test('refuses to overwrite an independently replaced destination while waiting', () => {
  const failure = Object.assign(new Error('temporarily locked'), { code: 'EPERM' })
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw failure
  })
  vi.spyOn(Atomics, 'wait').mockImplementation(() => {
    fs.renameSync(target, join(root, 'original.json'))
    fs.writeFileSync(target, 'independent')
    return 'timed-out'
  })
  expect(() => renameWorkbenchData(source, target, 'win32')).toThrow(failure)
  expect(fs.readFileSync(source, 'utf8')).toBe('completed')
  expect(fs.readFileSync(target, 'utf8')).toBe('independent')
})

test.each(['EXDEV', 'ENOENT'])('reports %s without waiting or altering files', code => {
  const failure = Object.assign(new Error('rename failed'), { code })
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw failure
  })
  const wait = vi.spyOn(Atomics, 'wait')
  expect(() => renameWorkbenchData(source, target, 'win32')).toThrow(failure)
  expect(wait).not.toHaveBeenCalled()
  expect(fs.readFileSync(target, 'utf8')).toBe('pending')
})

test.each(['darwin', 'linux'] as const)('keeps %s rename errors immediate', platform => {
  const failure = Object.assign(new Error('permission denied'), { code: 'EPERM' })
  vi.mocked(fs.renameSync).mockImplementationOnce(() => {
    throw failure
  })
  const wait = vi.spyOn(Atomics, 'wait')
  expect(() => renameWorkbenchData(source, target, platform)).toThrow(failure)
  expect(wait).not.toHaveBeenCalled()
  expect(fs.readFileSync(target, 'utf8')).toBe('pending')
})
