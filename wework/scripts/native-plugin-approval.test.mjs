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
        // xdotool defaults to OR: PID alone matches the already visible main window.
        return { stdout: args.includes('--all') ? '99\n' : '1\n' }
      }
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
      '--name',
      '^(Confirm Core plugin installation|Confirm Core plugin update|Core 插件安装确认|Core 插件更新确认)$',
    ])
    expect(control.command).toHaveBeenCalledWith('focusMainWindow', 'body')
  }
)

test('rejects an ambiguous native confirmation before sending any key', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux' })
  native.execute.mockResolvedValue({ stdout: '99\n100\n' })
  await expect(
    withNativePluginDecision({ applicationProcessId: 123, command: vi.fn() }, async () => null)
  ).rejects.toThrow('unambiguous')
  expect(native.execute).toHaveBeenCalledOnce()
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
