// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import { withNativePluginDecision } from '../e2e/desktop/modules/native-plugin-approval.mjs'

const native = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: native.execute,
  }),
}))
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
afterEach(() => {
  vi.useRealTimers()
  Object.defineProperty(process, 'platform', platform)
  native.execute.mockReset()
})

test.each([true, false])(
  'targets the real Linux modal, never a PID-only main window; allow=%s',
  async allow => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    let decide
    const decision = new Promise(resolve => {
      decide = resolve
    })
    native.execute.mockImplementation(async (_command, args) => {
      if (args[0] === 'search') {
        // GTK exposes only _NET_WM_NAME; this xdotool search reads the absent WM_NAME.
        if (args.includes('--name')) throw new Error('Legacy title search cannot see the modal')
        return { stdout: '1\n99\n' }
      }
      if (args[0] === 'getwindowname')
        return { stdout: args[1] === '99' ? 'Core 插件安装确认\n' : 'WeWork\n' }
      expect(args.slice(0, 3)).toEqual(['windowfocus', '--sync', '99'])
      expect(args.slice(5)).toEqual(allow ? ['Tab', 'Return'] : ['Escape'])
      decide()
      return { stdout: '' }
    })
    const control = { applicationProcessId: 123, command: vi.fn() }
    await expect(
      withNativePluginDecision(
        control,
        async () => {
          await decision
          return 'approved operation'
        },
        { allow }
      )
    ).resolves.toBe('approved operation')
    expect(native.execute.mock.calls[0][1]).toEqual([
      'search',
      '--all',
      '--sync',
      '--onlyvisible',
      '--pid',
      '123',
    ])
    expect(native.execute).toHaveBeenCalledWith(
      'xdotool',
      ['getwindowname', '99'],
      expect.anything()
    )
    expect(control.command).toHaveBeenCalledWith('focusMainWindow', 'body')
  }
)

test('rejects an ambiguous native confirmation before sending any key', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  native.execute.mockImplementation(async (_command, args) => ({
    stdout: args[0] === 'search' ? '99\n100\n' : 'Confirm Core plugin installation\n',
  }))
  await expect(
    withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
  ).rejects.toThrow('unambiguous')
  expect(native.execute.mock.calls.some(([, args]) => args[0] === 'windowfocus')).toBe(false)
})

test('captures only the owned modal before input and preserves the native rejection', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  let finishDecision
  const decisionSent = new Promise(resolve => {
    finishDecision = resolve
  })
  native.execute.mockImplementation(async (command, args) => {
    if (command === 'import') return { stdout: '' }
    if (command === 'gdbus') return { stdout: "('unix:abstract=synthetic-private-bus',)" }
    if (command === 'dpkg-query') return { stdout: 'installed' }
    if (args[0] === 'search') return { stdout: '1\n99\n' }
    if (args[0] === 'getwindowname')
      return { stdout: args[1] === '99' ? 'Confirm Core plugin update\n' : 'WeWork\n' }
    if (args[0] === 'getwindowfocus') return { stdout: '1\n' }
    finishDecision()
    return { stdout: '' }
  })
  const rejection = new Error('Core plugin installation was cancelled')
  try {
    await expect(
      withNativePluginDecision(
        {
          applicationProcessId: 123,
          command: vi.fn(),
          matrixEvidenceDirectory: '/isolated-evidence',
        },
        async () => {
          await decisionSent
          throw rejection
        }
      )
    ).rejects.toBe(rejection)
    expect(native.execute).toHaveBeenCalledWith(
      'import',
      [
        '-window',
        '99',
        expect.stringMatching(/^\/isolated-evidence\/native-plugin-decision-\d+\.png$/),
      ],
      expect.objectContaining({ timeout: 2_000 })
    )
    expect(log).toHaveBeenCalledWith(
      '[native-plugin-decision]',
      expect.stringContaining('"allow":true,"focus":"1"')
    )
    expect(log.mock.calls.flat().join(' ')).not.toContain('synthetic-private-bus')
    const calls = native.execute.mock.calls
    expect(calls.findIndex(([command]) => command === 'import')).toBeLessThan(
      calls.findIndex(([, args]) => args[0] === 'windowfocus')
    )
  } finally {
    log.mockRestore()
  }
})

test('waits for the actual modal instead of using the already visible owned main window', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let searches = 0
  native.execute.mockImplementation(async (_command, args) => {
    if (args[0] === 'search') return { stdout: ++searches === 1 ? '1\n' : '1\n99\n' }
    if (args[0] === 'getwindowname')
      return { stdout: args[1] === '99' ? 'Confirm Core plugin update\n' : 'WeWork\n' }
    return { stdout: '' }
  })
  const decision = withNativePluginDecision(
    { applicationProcessId: 123, command: vi.fn() },
    async () => null
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(native.execute.mock.calls.some(([, args]) => args[0] === 'windowfocus')).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  await decision
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['windowfocus', '--sync', '99', 'key', '--clearmodifiers', 'Tab', 'Return'],
    expect.anything()
  )
})

test('rejects at the unchanged deadline when only the owned main window exists', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  native.execute.mockImplementation(async (command, args) => ({
    stdout: command === 'xprop' ? '' : args[0] === 'search' ? '1\n' : 'WeWork\n',
  }))
  try {
    const decision = withNativePluginDecision(
      { applicationProcessId: 123, command: vi.fn() },
      async () => null
    )
    const rejected = expect(decision).rejects.toThrow(
      'did not display its native Core plugin decision'
    )
    await vi.advanceTimersByTimeAsync(12_000)
    await rejected
    expect(native.execute.mock.calls.some(([, args]) => args[0] === 'windowfocus')).toBe(false)
  } finally {
    log.mockRestore()
  }
})

test('retains a failed native search and records real X11 properties before cleanup', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const original = new Error('Native modal search timed out')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  native.execute.mockImplementation(async (command, args) => {
    if (command === 'xdotool') throw original
    if (args[0] === '-root') return { stdout: '_NET_CLIENT_LIST(WINDOW): window id # 0x123' }
    return {
      stdout: '_NET_WM_PID(CARDINAL) = 123\n_NET_WM_NAME(UTF8_STRING) = "Core 插件安装确认"',
    }
  })
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(native.execute.mock.calls.map(([command]) => command)).toEqual([
      'xdotool',
      'xprop',
      'xprop',
    ])
    expect(log).toHaveBeenCalledWith(
      '[native-plugin-window-diagnostics]',
      expect.stringContaining('_NET_WM_NAME(UTF8_STRING)')
    )
  } finally {
    log.mockRestore()
  }
})
