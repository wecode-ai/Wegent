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

test.each([
  ['native-decision-button-count:0', 0],
  ['native-decision-button-count:2', 2],
  ['native-decision-button-count:unknown', null],
])('records Windows button discovery coverage: %s', async (countLine, buttonCount) => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const original = Object.assign(new Error('Native decision terminated'), {
    stdout: [
      'native-decision:dialog-matched',
      'native-decision:button-search-started',
      'native-decision-timing:dialog-matched:9000',
      'native-decision-timing:button-search-started:9001',
      'native-decision-timing:private-value:10000',
      'native-decision-timing:started:not-a-time',
      countLine,
      'private-child-output',
    ].join('\n'),
  })
  native.execute.mockRejectedValue(original)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    const evidence = JSON.parse(log.mock.calls[0][1])
    expect(evidence).toMatchObject({
      stages: ['dialog-matched', 'button-search-started'],
      stageElapsedMs: { 'dialog-matched': 9000, 'button-search-started': 9001 },
      buttonCount,
    })
    expect(log.mock.calls.flat().join(' ')).not.toContain('private')
  } finally {
    log.mockRestore()
  }
})

test.each([
  ['MTA', 'MTA'],
  ['STA', 'STA'],
  ['private-apartment', null],
])('records only fixed Windows apartment states: %s', async (observed, expected) => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const original = Object.assign(new Error('Native decision terminated'), {
    stdout: `native-decision-apartment:${observed}\nprivate-child-output`,
  })
  native.execute.mockRejectedValue(original)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(JSON.parse(log.mock.calls[0][1]).apartmentState).toBe(expected)
    expect(log.mock.calls.flat().join(' ')).not.toContain('private')
  } finally {
    log.mockRestore()
  }
})

test('retains Windows native failure stages and the unchanged deadline without exposing child output', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const original = Object.assign(new Error('Native decision terminated'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
    stdout:
      'private-child-output\r\nnative-decision:started\r\nnative-decision:client-loaded\r\nnative-decision:search-started\r\nnative-decision:search-completed\r\nnative-decision:title-unmatched\r\nnative-decision:private-value\r\n',
    stderr: 'private-child-error',
  })
  native.execute.mockRejectedValue(original)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(native.execute).toHaveBeenCalledOnce()
    const [command, args, options] = native.execute.mock.calls[0]
    expect(command).toBe('powershell.exe')
    expect(args).toContain('-Mta')
    expect(options.timeout).toBe(12_000)
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
    expect(script).toContain('::ProcessIdProperty, 123')
    expect(script).toContain("::ClassNameProperty, '#32770'")
    expect(script).toContain(
      '::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window'
    )
    expect(script).toContain(
      '::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button'
    )
    expect(script).toContain(
      '$ownerWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree, $dialogCondition)'
    )
    expect(script).toContain('if ($decisions.Count -gt 1)')
    expect(script).toContain('UtcNow.AddSeconds(10)')
    expect(log).toHaveBeenCalledWith(
      '[native-plugin-decision-failed]',
      JSON.stringify({
        pid: 123,
        allow: true,
        code: null,
        killed: true,
        signal: 'SIGTERM',
        stages: [
          'started',
          'client-loaded',
          'search-started',
          'search-completed',
          'title-unmatched',
        ],
        stageElapsedMs: {},
        buttonCount: null,
        apartmentState: null,
      })
    )
    expect(log.mock.calls.flat().join(' ')).not.toContain('private')
  } finally {
    log.mockRestore()
  }
})
