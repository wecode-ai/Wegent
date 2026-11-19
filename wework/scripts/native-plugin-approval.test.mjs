// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { withNativePluginDecision } from '../e2e/desktop/modules/native-plugin-approval.mjs'
import {
  WINDOWS_UIA_STRUCTURE_DIAGNOSTICS,
  WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE,
  WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE,
  WINDOWS_NATIVE_DECISION_ASSEMBLY,
} from '../e2e/desktop/modules/native-plugin-window-diagnostics.mjs'

const native = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: native.execute,
  }),
}))
const observerDirectory = process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY
beforeEach(() => {
  process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY = 'C:/wework-observer'
})
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
test('the initial zero-button snapshot is read-only, sampled once, and precedes the search deadline', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  native.execute.mockResolvedValue({ stdout: '' })
  await withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
  const script = Buffer.from(native.execute.mock.calls[0][1].at(-1), 'base64').toString('utf16le')
  expect(script.indexOf(WINDOWS_UIA_STRUCTURE_DIAGNOSTICS)).toBeLessThan(
    script.lastIndexOf('Start-Sleep -Milliseconds 100')
  )
  expect(WINDOWS_UIA_STRUCTURE_DIAGNOSTICS).toContain(
    "$buttons.Count -eq 0 -and -not $decisionStages.Contains('uia-structure-started')"
  )
  expect(WINDOWS_UIA_STRUCTURE_DIAGNOSTICS).not.toMatch(/\.Name|Invoke|GetWindowText|Start-Sleep/)
  expect(script.split('::TrueCondition)').length - 1).toBe(1)
})
afterEach(() => {
  if (observerDirectory === undefined) delete process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY
  else process.env.WEWORK_E2E_NATIVE_OBSERVER_DIRECTORY = observerDirectory
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
    expect(native.execute).toHaveBeenCalledTimes(2)
    const [, observerArgs, observerOptions] = native.execute.mock.calls[1]
    expect(observerOptions.timeout).toBe(4_000)
    const observer = Buffer.from(observerArgs.at(-1), 'base64').toString('utf16le')
    expect(observer).not.toMatch(/UIAutomation|Invoke|SendMessage|PostMessage|SendInput/)
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
      '$nativeButton.Current.ControlType.Id -ne [System.Windows.Automation.ControlType]::Button.Id'
    )
    expect(script).toContain(
      '$ownerWindow.FindAll([System.Windows.Automation.TreeScope]::Subtree, $dialogCondition)'
    )
    expect(script).toContain('if ($decisions.Count -gt 1)')
    expect(script).toContain('UtcNow.AddSeconds(10)')
    expect(script).not.toContain('empty-button-diagnostics')
    expect(script).toContain('DialogButtons($dialogHandle, $targetPid)')
    expect(script).toContain('::FromHandle($buttonHandle)')
    expect(script).not.toContain('SendMessage')
    expect(script).toContain(
      'OwnedButton($dialogHandle, [IntPtr]$button.Current.NativeWindowHandle, $targetPid)'
    )
    expect(script).toContain('if ($matchingButtons.Count -gt 1)')
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
        emptyButtonDiagnostics: {
          'uia-descendants': null,
          'uia-buttons': null,
          'uia-button-pid-matches': null,
          'uia-button-type-matches': null,
          'uia-button-handle-matches': null,
          'uia-button-control-type-id': null,
          'uia-provider-button-factories': null,
          'uia-provider-created-matches': null,
          'native-handle-present': null,
          'native-pid-matches': null,
          'native-dialog-class-matches': null,
          'win32-children': null,
          'win32-buttons': null,
        },
      })
    )
    expect(log.mock.calls.flat().join(' ')).not.toContain('private')
  } finally {
    log.mockRestore()
  }
})

test.each([
  ['uia-descendants', '0', 0],
  ['uia-buttons', '2', 2],
  ['native-handle-present', '0', 0],
  ['native-pid-matches', '1', 1],
  ['native-dialog-class-matches', '0', 0],
  ['win32-children', '4', 4],
  ['win32-buttons', '2', 2],
  ['uia-button-pid-matches', '0', 0],
  ['uia-button-type-matches', '1', 1],
  ['uia-button-handle-matches', '0', 0],
  ['uia-button-control-type-id', '50033', 50033],
  ['uia-provider-button-factories', '1', 1],
  ['uia-provider-created-matches', '0', 0],
  ['uia-provider-created-matches', '1', 1],
  ['uia-provider-created-matches', '2', null],
  ['uia-button-pid-matches', '2', null],
  ['uia-button-type-matches', '2', null],
  ['uia-button-handle-matches', '2', null],
  ['uia-button-control-type-id', 'unknown', null],
  ['uia-descendants', '-1', null],
  ['uia-buttons', 'unknown', null],
  ['native-handle-present', '2', null],
  ['native-pid-matches', '3', null],
  ['native-dialog-class-matches', '3', null],
  ['win32-children', '9007199254740992', null],
])('retains bounded native structure evidence: %s=%s', async (field, value, expected) => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const original = Object.assign(new Error('Native decision terminated'), {
    stdout: `native-decision-structure:${field}:${value}\nnative-decision-structure:private-field:42\nprivate-child-output`,
  })
  native.execute.mockRejectedValue(original)
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    await expect(
      withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
    ).rejects.toBe(original)
    expect(JSON.parse(log.mock.calls[0][1]).emptyButtonDiagnostics[field]).toBe(expected)
    expect(log.mock.calls.flat().join(' ')).not.toContain('private')
  } finally {
    log.mockRestore()
  }
})

test.each([false, true])(
  'observes Win32 structure only after native failure and preserves that failure; observer failure=%s',
  async observerFails => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const original = Object.assign(new Error('Native decision terminated'), {
      killed: true,
      signal: 'SIGTERM',
      stdout:
        'native-decision:dialog-matched\nnative-decision-button-count:0\nnative-decision-structure:uia-descendants:5\nnative-decision-structure:uia-buttons:0\n',
    })
    native.execute.mockRejectedValueOnce(original)
    if (observerFails)
      native.execute.mockRejectedValueOnce(
        Object.assign(new Error('private-observer-error'), {
          killed: true,
          signal: 'SIGTERM',
          stdout: 'native-decision:observer-started\nprivate-observer-output',
        })
      )
    else
      native.execute.mockResolvedValueOnce({
        stdout:
          'native-decision:observer-started\nnative-decision:observer-dialog-matched\nnative-decision-structure:win32-children:4\nnative-decision-structure:win32-buttons:2\nnative-decision:observer-completed\n',
      })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(
        withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
      ).rejects.toBe(original)
      expect(native.execute).toHaveBeenCalledTimes(2)
      expect(native.execute.mock.calls.map(call => call[2].timeout)).toEqual([12_000, 4_000])
      const input = Buffer.from(native.execute.mock.calls[0][1].at(-1), 'base64').toString(
        'utf16le'
      )
      const observer = Buffer.from(native.execute.mock.calls[1][1].at(-1), 'base64').toString(
        'utf16le'
      )
      expect(input).toContain('UtcNow.AddSeconds(10)')
      expect(input).toContain('DialogButtons($dialogHandle, $targetPid)')
      expect(input).not.toContain('observer-started')
      expect(observer).toContain('$targetPid = 123')
      expect(observer).toContain('Confirm Core plugin installation')
      expect(observer).toContain('Core 插件更新确认')
      expect(WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE).toContain('pid != expectedPid')
      expect(WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE).toContain('name.ToString() != "#32770"')
      expect(WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE).toContain(
        'Array.IndexOf(titles, title.ToString()) < 0'
      )
      expect(WINDOWS_NATIVE_DIALOG_STRUCTURE_SOURCE).toContain('if (matches.Count != 1)')
      expect(observer).not.toMatch(
        /InvokePattern|SendMessage|SetForegroundWindow|mouse_event|keybd_event|Start-Sleep/
      )
      const observed = JSON.parse(
        log.mock.calls.find(call => call[0] === '[native-plugin-window-diagnostics]')[1]
      )
      expect(observed.phase).toBe('after-decision-failure')
      expect(observed.emptyButtonDiagnostics['win32-buttons']).toBe(observerFails ? null : 2)
      expect(observed.failure?.killed ?? false).toBe(observerFails)
      expect(log.mock.calls.flat().join(' ')).not.toContain('private')
    } finally {
      log.mockRestore()
    }
  }
)

test.each([true, false])(
  'discovers owned native Button handles and preserves the UIA action contract; allow=%s',
  async allow => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    native.execute.mockResolvedValue({ stdout: '' })
    await withNativePluginDecision(
      { applicationProcessId: 123, command: vi.fn() },
      async () => null,
      { allow }
    )
    const script = Buffer.from(native.execute.mock.calls[0][1].at(-1), 'base64').toString('utf16le')
    expect(script).not.toContain(
      '$window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $buttonCondition)'
    )
    expect(script).toContain('DialogButtons($dialogHandle, $targetPid)')
    expect(script).toContain(WINDOWS_NATIVE_DECISION_ASSEMBLY)
    expect(script).not.toContain('-TypeDefinition')
    expect(WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE).toContain('ClassMatches(dialog, "#32770")')
    expect(WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE).toContain(
      'String.Equals(name.ToString(), "Button", StringComparison.OrdinalIgnoreCase)'
    )
    expect(WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE).toContain(
      'IsWindowVisible(child) && IsWindowEnabled(child)'
    )
    expect(WINDOWS_NATIVE_DIALOG_BUTTON_SOURCE).toContain(
      'OwnedWindow(button, expectedPid) && IsChild(dialog, button)'
    )
    expect(script).toContain('::FromHandle($buttonHandle)')
    expect(script).toContain('if ($matchingButtons.Count -gt 1)')
    expect(script).toContain('$button.Current.Name -notin $allowedButtonNames')
    expect(script).toContain('[System.Windows.Automation.InvokePattern]::Pattern')
    expect(script).not.toMatch(/SendMessage|PostMessage|SendInput|mouse_event|keybd_event/)
    expect(script.indexOf("Write-DecisionStage 'selection-revalidated'")).toBeLessThan(
      script.indexOf('$pattern.Invoke()')
    )
    expect(script).toContain(
      allow ? "'Allow installation', 'Allow update', '允许安装', '允许更新'" : "'Cancel', '取消'"
    )
  }
)

test('Windows encoded native input fits the CreateProcess command-line limit', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  native.execute.mockResolvedValue({ stdout: '' })
  await withNativePluginDecision(
    { applicationProcessId: 2147483647, command: vi.fn() },
    async () => null
  )
  const [command, args] = native.execute.mock.calls[0]
  const commandLine = [command, ...args].map(arg => '"' + arg + '"').join(' ')
  expect(commandLine.length + 1).toBeLessThanOrEqual(32767)
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  expect(script).toContain('DialogButtons($dialogHandle, $targetPid)')
  expect(script).not.toContain('FindAndRead(')
  expect(script).not.toContain('private static int[] Read(')
})

test('native identity rejection records only fixed numeric facts before retaining its failure', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  native.execute.mockResolvedValue({ stdout: '' })
  await withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
  const script = Buffer.from(native.execute.mock.calls[0][1].at(-1), 'base64').toString('utf16le')
  const diagnostic = script.slice(
    script.indexOf('        try {'),
    script.indexOf("throw 'The native Button handle did not expose its owned UIA Button'")
  )
  for (const field of ['pid-matches', 'type-matches', 'handle-matches', 'control-type-id'])
    expect(diagnostic).toContain('native-decision-structure:uia-button-' + field + ':')
  expect(diagnostic).toContain("Write-DecisionStage 'button-identity-diagnostics-failed'")
  expect(diagnostic).not.toMatch(/\.Name|GetWindowText|SendInput|Invoke\(/)
})
