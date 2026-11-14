// @vitest-environment node

import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, test, vi } from 'vitest'

vi.mock('../e2e/desktop/modules/shared.mjs', async importOriginal => ({
  ...(await importOriginal()),
  runChecked: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}))

import { captureVerificationScreenshot } from '../e2e/desktop/modules/workspace-flows.mjs'
import { join, resultDir, runChecked, writeFile } from '../e2e/desktop/modules/shared.mjs'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
const diagnostics = JSON.stringify({ version: 1, events: ['real-capture-boundary'] })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('WEWORK_E2E_SCREENSHOTS', 'all')
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.unstubAllEnvs()
})

function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(type, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

function png(width, height) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function captureControl(image, metrics = {}) {
  return {
    command: vi.fn(async action => {
      if (action === 'getConversationDiagnosticsSnapshot') return diagnostics
      if (action === 'getElementMetrics')
        return JSON.stringify([
          {
            viewportWidth: 1440,
            viewportHeight: 900,
            width: 1200,
            height: 800,
            devicePixelRatio: 1,
            ...metrics,
          },
        ])
      if (action === 'capture') return `data:image/png;base64,${image.toString('base64')}`
      assert.fail(`Unexpected screenshot command ${action}`)
    }),
  }
}

test('explicit Linux primary-view capture saves the full viewport and its existing diagnostics', async () => {
  const image = png(1440, 900)
  const control = captureControl(image)
  const path = await captureVerificationScreenshot(control, 'wide.png', 'body', {
    surface: 'primary-view',
  })
  assert.equal(path, join(resultDir, 'wide.png'))
  assert.deepEqual(
    control.command.mock.calls.map(([action]) => action),
    ['getConversationDiagnosticsSnapshot', 'getElementMetrics', 'capture']
  )
  assert.deepEqual(control.command.mock.calls.at(-1), ['capture', 'body', { timeoutMs: 90_000 }])
  assert.equal(runChecked.mock.calls.length, 0)
  assert.deepEqual(writeFile.mock.calls, [
    [join(resultDir, 'wide.png.conversation-diagnostics.json'), `${diagnostics}\n`, 'utf8'],
    [path, image],
  ])
  const saved = writeFile.mock.calls[1][1]
  assert.deepEqual([saved.readUInt32BE(16), saved.readUInt32BE(20)], [1440, 900])
})

test('the existing Linux default still captures the desktop root', async () => {
  const control = captureControl(png(1, 1))
  const path = await captureVerificationScreenshot(control, 'default.png', 'body')
  assert.deepEqual(runChecked.mock.calls, [['import', ['-window', 'root', path]]])
  assert.deepEqual(control.command.mock.calls, [['getConversationDiagnosticsSnapshot', 'body']])
  assert.equal(writeFile.mock.calls.length, 1)
})

test.each([
  [7, 5],
  [14, 10],
])(
  'selector crop accepts the host-supported %ix%i dimensions with DPR 2',
  async (width, height) => {
    const image = png(width, height)
    const control = captureControl(image, { width: 7, height: 5, devicePixelRatio: 2 })
    await captureVerificationScreenshot(control, 'crop.png', '[data-testid="feature"]', {
      surface: 'primary-view',
    })
    assert.deepEqual(writeFile.mock.calls.at(-1)[1], image)
  }
)

test.each([
  [1280, 720, {}, 'body'],
  [14, 5, { width: 7, height: 5, devicePixelRatio: 2 }, '[data-testid="feature"]'],
])(
  'rejects mismatched %ix%i screenshots without root capture or a PNG write',
  async (w, h, metrics, selector) => {
    const control = captureControl(png(w, h), metrics)
    await assert.rejects(
      captureVerificationScreenshot(control, 'bad-size.png', selector, { surface: 'primary-view' }),
      /does not match/
    )
    assert.equal(runChecked.mock.calls.length, 0)
    assert.equal(writeFile.mock.calls.length, 1)
  }
)

test('primary capture propagates the original failure once and preserves diagnostics', async () => {
  const failure = new Error('Native main WebContents capture failed')
  const control = captureControl(png(1, 1))
  const command = control.command.getMockImplementation()
  control.command.mockImplementation((action, ...args) =>
    action === 'capture' ? Promise.reject(failure) : command(action, ...args)
  )
  await assert.rejects(
    captureVerificationScreenshot(control, 'failed.png', 'body', { surface: 'primary-view' }),
    error => error === failure
  )
  assert.equal(control.command.mock.calls.filter(([action]) => action === 'capture').length, 1)
  assert.equal(runChecked.mock.calls.length, 0)
  assert.equal(writeFile.mock.calls.length, 1)
})

test('invalid native PNG output fails before writing misleading visual evidence', async () => {
  const control = captureControl(Buffer.from('not a PNG'))
  await assert.rejects(
    captureVerificationScreenshot(control, 'invalid.png', 'body', { surface: 'primary-view' }),
    /no valid PNG dimensions/
  )
  assert.equal(writeFile.mock.calls.length, 1)
  assert.equal(runChecked.mock.calls.length, 0)
})
