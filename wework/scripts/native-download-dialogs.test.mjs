// @vitest-environment node
import { afterEach, expect, test, vi } from 'vitest'
import {
  clickLinuxPointer,
  listVisibleDialogsForPid,
} from '../e2e/desktop/modules/native-download-dialogs.mjs'

const native = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: native.execute,
  }),
}))

const geometryError =
  'X Error of failed request:  BadDrawable (invalid Pixmap or Window parameter)\n' +
  '  Major opcode of failed request:  14 (X_GetGeometry)\n'

afterEach(() => {
  vi.useRealTimers()
  native.execute.mockReset()
})

test('releases the native button even when press observation fails', async () => {
  native.execute.mockResolvedValue({ stdout: '' })
  const error = new Error('The renderer did not observe the press')
  const observePress = async () => {
    expect(native.execute.mock.calls.map(([, args]) => args)).toEqual([['mousedown', '1']])
    throw error
  }

  await expect(clickLinuxPointer(1, observePress)).rejects.toBe(error)
  expect(native.execute.mock.calls.map(([, args]) => args)).toEqual([
    ['mousedown', '1'],
    ['mouseup', '1'],
  ])
})

test.each([geometryError, 'X Error of failed request:  BadWindow (invalid Window parameter)'])(
  'discards an interrupted search and still detects the visible native dialog (%s)',
  async stderr => {
    native.execute
      .mockRejectedValueOnce(
        Object.assign(new Error('Interrupted window search'), { code: 1, stderr })
      )
      .mockResolvedValueOnce({ stdout: '42\n' })
      .mockResolvedValueOnce({ stdout: '_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG\n' })

    await expect(listVisibleDialogsForPid(123)).resolves.toMatchObject([{ windowId: '42' }])
  }
)

test('reports an empty window list when xdotool finds no matches', async () => {
  native.execute.mockRejectedValueOnce(
    Object.assign(new Error('No matches'), { code: 1, stderr: '' })
  )

  await expect(listVisibleDialogsForPid(123)).resolves.toEqual([])
})

test('preserves unexpected xdotool failures', async () => {
  const error = Object.assign(new Error('Display unavailable'), { code: 1, stderr: 'No display' })
  native.execute.mockRejectedValueOnce(error)

  await expect(listVisibleDialogsForPid(123)).rejects.toBe(error)
})

test('fails when repeated interrupted searches exhaust the original timeout', async () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const error = Object.assign(new Error('Interrupted window search'), {
    code: 1,
    stderr: geometryError,
  })
  native.execute.mockImplementation(async (_command, _args, { timeout }) => {
    vi.advanceTimersByTime(Math.min(15, timeout))
    throw error
  })

  await expect(listVisibleDialogsForPid(123, 20)).rejects.toBe(error)
  expect(native.execute.mock.calls.map(([, , options]) => options.timeout)).toEqual([20, 5])
})
