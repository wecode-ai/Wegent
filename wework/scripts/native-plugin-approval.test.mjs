// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import {
  NATIVE_PLUGIN_DECISION_TIMEOUT_MS,
  withNativePluginDecision,
} from '../e2e/desktop/modules/native-plugin-approval.mjs'

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
      if (args[0] === 'windowfocus') {
        expect(args).toEqual(['windowfocus', '--sync', '99'])
        return { stdout: '' }
      }
      expect(args).toEqual(['key', '--clearmodifiers', ...(allow ? ['Tab', 'Return'] : ['Escape'])])
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

test.each([true, false])(
  'finishes the admitted native key release before an operation rejection escapes; allow=%s',
  async allow => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    let keyDown
    const pressed = new Promise(resolve => {
      keyDown = resolve
    })
    const events = []
    let keyHeld = false
    native.execute.mockImplementation(async (_command, args, options) => {
      if (args[0] === 'search') return { stdout: '99\n' }
      if (args[0] === 'getwindowname') return { stdout: 'Confirm Core plugin installation\n' }
      if (!args.includes('key')) return { stdout: '' }
      expect(args.slice(args.indexOf('key') + 1)).toEqual([
        '--clearmodifiers',
        ...(allow ? ['Tab', 'Return'] : ['Escape']),
      ])
      keyHeld = true
      events.push('key-down')
      return new Promise((resolve, reject) => {
        let terminated = false
        options.signal?.addEventListener(
          'abort',
          () => {
            terminated = true
            events.push('input-aborted')
            reject(new Error('Native input was terminated before key-up'))
          },
          { once: true }
        )
        keyDown()
        // Model the native process's separate key-up after the dialog reacts to key-down.
        setImmediate(() => {
          if (terminated) return
          keyHeld = false
          events.push('key-up')
          resolve({ stdout: '' })
        })
      })
    })
    const original = new Error('The operation rejected after native key-down')
    const verification = withNativePluginDecision(
      { applicationProcessId: 123, command: vi.fn() },
      async () => {
        await pressed
        events.push('operation-rejected')
        throw original
      },
      { allow }
    )
    await expect(verification).rejects.toBe(original)
    events.push('caller-rejected')
    expect(keyHeld).toBe(false)
    expect(events).toEqual(['key-down', 'operation-rejected', 'key-up', 'caller-rejected'])
  }
)

test('aborts a pending modal search when the operation fails before native input', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let startSearch
  const searching = new Promise(resolve => {
    startSearch = resolve
  })
  let searchSignal
  native.execute.mockImplementation(async (_command, args, options) => {
    expect(args[0]).toBe('search')
    searchSignal = options.signal
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('Search aborted')))
      startSearch()
    })
  })
  const original = new Error('The operation failed before displaying a dialog')
  await expect(
    withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => {
      await searching
      throw original
    })
  ).rejects.toBe(original)
  expect(searchSignal.aborted).toBe(true)
  expect(native.execute).toHaveBeenCalledOnce()
})

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

test('ignores a vanished X11 window while still selecting the owned native modal', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  native.execute.mockImplementation(async (_command, args) => {
    if (args[0] === 'search') return { stdout: '1\n99\n' }
    if (args[0] === 'getwindowname') {
      if (args[1] === '1') {
        throw Object.assign(new Error('The window disappeared'), {
          code: 1,
          stderr: 'X Error of failed request: BadWindow (invalid Window parameter)',
        })
      }
      return { stdout: 'Confirm Core plugin installation\n' }
    }
    return { stdout: '' }
  })
  await withNativePluginDecision(
    { applicationProcessId: 123, command: vi.fn() },
    async () => 'installed'
  )
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['windowfocus', '--sync', '99'],
    expect.anything()
  )
  expect(native.execute).not.toHaveBeenCalledWith(
    'xdotool',
    ['windowfocus', '--sync', '1'],
    expect.anything()
  )
})

test('re-enumerates vanished X11 windows within the original decision deadline', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let searches = 0
  native.execute.mockImplementation(async (_command, args) => {
    if (args[0] === 'search') return { stdout: ++searches === 1 ? '1\n' : '99\n' }
    if (args[0] === 'getwindowname') {
      if (args[1] === '1') {
        throw Object.assign(new Error('The window disappeared'), {
          code: 1,
          stderr: 'BadWindow (invalid Window parameter)',
        })
      }
      return { stdout: 'Confirm Core plugin installation\n' }
    }
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
  expect(searches).toBe(2)
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['windowfocus', '--sync', '99'],
    expect.anything()
  )
})

test('preserves unexpected X11 property failures without sending native input', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const original = Object.assign(new Error('Permission denied'), {
    code: 1,
    stderr: 'Access denied',
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  native.execute.mockImplementation(async (command, args) => {
    if (command === 'xprop') return { stdout: '' }
    if (args[0] === 'search') return { stdout: '99\n' }
    throw original
  })
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(
      native.execute.mock.calls.some(([, args]) => ['windowfocus', 'key'].includes(args[0]))
    ).toBe(false)
  } finally {
    log.mockRestore()
  }
})

test('discards an interrupted X11 tree scan and discovers only the owned modal', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  let searches = 0
  const searchTimeouts = []
  native.execute.mockImplementation(async (_command, args, options) => {
    if (args[0] === 'search') {
      expect(args).toEqual(['search', '--all', '--sync', '--onlyvisible', '--pid', '123'])
      searchTimeouts.push(options.timeout)
      if (++searches === 1) {
        throw Object.assign(new Error('Window vanished during X_QueryTree'), {
          code: 1,
          stdout: '666\n',
          stderr:
            'X Error of failed request: BadWindow (invalid Window parameter)\n' +
            '  Major opcode of failed request: 15 (X_QueryTree)',
        })
      }
      return { stdout: '1\n99\n' }
    }
    if (args[0] === 'getwindowname') {
      expect(args[1]).not.toBe('666')
      return { stdout: args[1] === '99' ? 'Confirm Core plugin update\n' : 'WeWork\n' }
    }
    return { stdout: '' }
  })
  const decision = withNativePluginDecision(
    { applicationProcessId: 123, command: vi.fn() },
    async () => 'installed'
  )
  const completed = decision.then(
    value => ({ value }),
    error => ({ error })
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(native.execute.mock.calls.some(([, args]) => args[0] === 'windowfocus')).toBe(false)
  await vi.advanceTimersByTimeAsync(100)
  expect(await completed).toEqual({ value: 'installed' })
  expect(searchTimeouts).toEqual([12_000, 11_900])
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['windowfocus', '--sync', '99'],
    expect.anything()
  )
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['key', '--clearmodifiers', 'Tab', 'Return'],
    expect.anything()
  )
})

test('vanishing X11 trees cannot extend the native decision deadline or admit input', async () => {
  vi.useFakeTimers()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const timeouts = []
  native.execute.mockImplementation(async (command, args, options) => {
    if (command === 'xprop') return { stdout: '' }
    expect(args[0]).toBe('search')
    timeouts.push(options.timeout)
    throw Object.assign(new Error('Tree window disappeared'), {
      code: 1,
      stderr: 'BadWindow (invalid Window parameter)',
    })
  })
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
    expect(timeouts[0]).toBe(12_000)
    expect(timeouts.at(-1)).toBe(100)
    expect(timeouts.every((timeout, index) => timeout === 12_000 - index * 100)).toBe(true)
    expect(
      native.execute.mock.calls.some(([, args]) => ['windowfocus', 'key'].includes(args[0]))
    ).toBe(false)
  } finally {
    log.mockRestore()
  }
})

test('rejects non-BadWindow enumeration failures without native input', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  const original = Object.assign(new Error('X11 access denied'), {
    code: 1,
    stderr: 'Access denied',
  })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  native.execute.mockImplementation(async (command, args) => {
    if (command === 'xprop') return { stdout: '' }
    expect(args[0]).toBe('search')
    throw original
  })
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(
      native.execute.mock.calls.some(([, args]) => ['windowfocus', 'key'].includes(args[0]))
    ).toBe(false)
    expect(native.execute.mock.calls.filter(([, args]) => args[0] === 'search')).toHaveLength(1)
  } finally {
    log.mockRestore()
  }
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
    if (args[0] === 'windowfocus') return { stdout: '' }
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
    ['windowfocus', '--sync', '99'],
    expect.anything()
  )
  expect(native.execute).toHaveBeenCalledWith(
    'xdotool',
    ['key', '--clearmodifiers', 'Tab', 'Return'],
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
    await vi.advanceTimersByTimeAsync(NATIVE_PLUGIN_DECISION_TIMEOUT_MS + 1)
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
