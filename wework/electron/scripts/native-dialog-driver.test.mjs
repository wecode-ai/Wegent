import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, test, vi } from 'vitest'
import { createNativeDialogDriver } from './native-dialog-driver.mjs'

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(),
  shutdown: vi.fn(),
}))

vi.mock('@trycua/cua-driver', () => ({
  CuaDriver: { create: () => mocks },
}))

beforeEach(() => {
  vi.clearAllMocks()
})

test('loads the native dialog driver through Node ESM package exports', () => {
  const script = `
    import assert from 'node:assert/strict'
    const { createNativeDialogDriver } = await import('./scripts/native-dialog-driver.mjs')
    assert.equal(typeof createNativeDialogDriver, 'function')
  `

  expect(() =>
    execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      stdio: 'pipe',
      timeout: 10_000,
    })
  ).not.toThrow()
})

test('rejects a degraded accessibility tree instead of treating its window title as controls', async () => {
  mocks.callTool.mockResolvedValue({
    isError: false,
    structuredJson: JSON.stringify({
      degraded: true,
      degraded_reason: 'AT-SPI connect failed',
      elements: [{ role: 'window', label: 'Select Folder' }],
    }),
    images: [],
  })
  const native = await createNativeDialogDriver({ pid: 42, timeoutMs: 1_000 })

  try {
    await expect(native.snapshot(1)).rejects.toThrow('AT-SPI connect failed')
  } finally {
    await native.close()
  }
})

test('returns native accessibility controls when the tree is available', async () => {
  const state = {
    degraded: false,
    elements: [{ role: 'push button', label: 'Open', element_token: 's00000001:1' }],
  }
  mocks.callTool.mockResolvedValue({
    isError: false,
    structuredJson: JSON.stringify(state),
    images: [],
  })
  const native = await createNativeDialogDriver({ pid: 42, timeoutMs: 1_000 })

  try {
    await expect(native.snapshot(1)).resolves.toEqual(state)
  } finally {
    await native.close()
  }
})

test('records each location input stage and the native window closing after submission', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'native-dialog-driver-'))
  let open = true
  mocks.callTool.mockImplementation(async (name, encodedArgs) => {
    const args = JSON.parse(encodedArgs)
    if (name === 'press_key' && args.key === 'return') open = false
    const data =
      name === 'list_windows'
        ? { windows: open ? [{ pid: 42, window_id: 7 }] : [] }
        : name === 'get_window_state'
          ? { elements: [{ role: 'dialog', label: 'Select Folder' }], degraded: false }
          : { effect: 'unverifiable' }
    return {
      isError: false,
      text: `${name} delivered`,
      structuredJson: JSON.stringify(data),
      images: [{ mimeType: 'image/png', dataBase64: Buffer.from('fixture').toString('base64') }],
    }
  })
  const native = await createNativeDialogDriver({ pid: 42, resultDir, timeoutMs: 1_000 })

  try {
    await native.selectDirectory(7, '/fixture/directory')
    const actions = (await readFile(join(resultDir, 'native-dialog-actions.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(
      actions.filter(action => action.stage).map(({ stage, open }) => ({ stage, open }))
    ).toEqual([
      { stage: 'location-shortcut', open: true },
      { stage: 'location-typed', open: true },
      { stage: 'location-submitted', open: false },
    ])
    expect(actions.filter(action => action.name).every(action => action.text)).toBe(true)
    expect(await readdir(resultDir)).toEqual(
      expect.arrayContaining([
        'native-picker-7-location-shortcut.png',
        'native-picker-7-location-typed.png',
        'native-window-catalog.jsonl',
      ])
    )
  } finally {
    await native.close()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('retains failed input evidence before rejecting the action', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'native-dialog-driver-'))
  mocks.callTool.mockResolvedValue({ isError: true, text: 'input delivery failed', images: [] })
  const native = await createNativeDialogDriver({ pid: 42, resultDir, timeoutMs: 1_000 })

  try {
    await expect(native.selectDirectory(7, '/fixture/directory')).rejects.toThrow(
      'input delivery failed'
    )
    const action = JSON.parse(
      await readFile(join(resultDir, 'native-dialog-actions.jsonl'), 'utf8')
    )
    expect(action.name).toBe('press_key')
    expect(action.text).toBe('input delivery failed')
  } finally {
    await native.close()
    await rm(resultDir, { recursive: true, force: true })
  }
})
