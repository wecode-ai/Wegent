import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { copyTextToClipboard } from './clipboard'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime: vi.fn() }))

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const originalExecCommand = Object.getOwnPropertyDescriptor(document, 'execCommand')
const writeText = vi.fn()
const execCommand = vi.fn()

beforeEach(() => {
  vi.mocked(isElectronRuntime).mockReturnValue(false)
  vi.mocked(invokeDesktopHost).mockReset().mockResolvedValue(undefined)
  writeText.mockReset().mockResolvedValue(undefined)
  execCommand.mockReset().mockReturnValue(true)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
})

afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  if (originalExecCommand) Object.defineProperty(document, 'execCommand', originalExecCommand)
  else Reflect.deleteProperty(document, 'execCommand')
})

test('copies through the Electron clipboard service on desktop', async () => {
  vi.mocked(isElectronRuntime).mockReturnValue(true)

  await copyTextToClipboard('SELECT 1')

  expect(invokeDesktopHost).toHaveBeenCalledExactlyOnceWith('clipboard.writeText', {
    text: 'SELECT 1',
  })
  expect(writeText).not.toHaveBeenCalled()
  expect(execCommand).not.toHaveBeenCalled()
})

test('uses the browser Clipboard API when available', async () => {
  await copyTextToClipboard('SELECT 1')

  expect(writeText).toHaveBeenCalledExactlyOnceWith('SELECT 1')
  expect(execCommand).not.toHaveBeenCalled()
})

test('preserves legacy browser copying when the Clipboard API is unavailable', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  execCommand.mockImplementation(() => {
    expect(document.querySelector('textarea')).toHaveValue('SELECT 1')
    return true
  })

  await copyTextToClipboard('SELECT 1')

  expect(execCommand).toHaveBeenCalledExactlyOnceWith('copy')
  expect(document.querySelector('textarea')).toBeNull()
})

test('rejects failed legacy copying and removes its temporary element', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
  execCommand.mockReturnValue(false)

  await expect(copyTextToClipboard('SELECT 1')).rejects.toThrow('Clipboard copy is not supported')

  expect(document.querySelector('textarea')).toBeNull()
})

test('preserves Clipboard API failures without invoking another copy method', async () => {
  writeText.mockRejectedValue(new Error('Clipboard denied'))

  await expect(copyTextToClipboard('SELECT 1')).rejects.toThrow('Clipboard denied')

  expect(execCommand).not.toHaveBeenCalled()
})
