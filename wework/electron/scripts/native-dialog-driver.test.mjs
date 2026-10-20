import { execFileSync } from 'node:child_process'
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
