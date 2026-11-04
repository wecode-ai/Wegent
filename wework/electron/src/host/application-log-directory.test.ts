import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { openApplicationLogDirectory } from './application-log-directory.js'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  mkdir: vi.fn(),
  openExternal: vi.fn(),
  openPath: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  shell: { openExternal: mocks.openExternal, openPath: mocks.openPath },
}))
vi.mock('node:fs/promises', () => ({ mkdir: mocks.mkdir }))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { value: 'linux' })
  mocks.getPath.mockReturnValue('/home/test/wework logs')
  mocks.mkdir.mockResolvedValue(undefined)
  mocks.openExternal.mockResolvedValue(undefined)
  mocks.openPath.mockResolvedValue('')
})

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
})

describe('application log directory', () => {
  test('encodes Linux file URLs and awaits the native opener result', async () => {
    const directory = '/home/test/日志 #?%/wework logs'
    mocks.getPath.mockReturnValue(directory)
    let complete: () => void = () => {}
    mocks.openExternal.mockReturnValue(
      new Promise<void>(resolve => {
        complete = resolve
      })
    )
    let finished = false
    const opening = openApplicationLogDirectory().then(() => {
      finished = true
    })

    await vi.waitFor(() => expect(mocks.openExternal).toHaveBeenCalledOnce())
    expect(mocks.getPath).toHaveBeenCalledExactlyOnceWith('logs')
    expect(mocks.mkdir).toHaveBeenCalledExactlyOnceWith(directory, { recursive: true })
    expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(
      'file:///home/test/%E6%97%A5%E5%BF%97%20%23%3F%25/wework%20logs'
    )
    expect(mocks.openPath).not.toHaveBeenCalled()
    expect(finished).toBe(false)
    complete()
    await opening
    expect(finished).toBe(true)
  })

  test('propagates Linux native opener rejection', async () => {
    const error = new Error('Failed to open path')
    mocks.openExternal.mockRejectedValue(error)

    await expect(openApplicationLogDirectory()).rejects.toBe(error)
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  test('propagates directory creation failure before launching an opener', async () => {
    const error = new Error('Log path is not a directory')
    mocks.mkdir.mockRejectedValue(error)

    await expect(openApplicationLogDirectory()).rejects.toBe(error)
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.openPath).not.toHaveBeenCalled()
  })

  test.each(['darwin', 'win32'])('uses native paths on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    const directory =
      platform === 'win32' ? 'C:\\Users\\test\\wework logs' : '/Users/test/wework logs'
    mocks.getPath.mockReturnValue(directory)

    await openApplicationLogDirectory()

    expect(mocks.openPath).toHaveBeenCalledExactlyOnceWith(directory)
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  test.each(['darwin', 'win32'])('propagates native path errors on %s', async platform => {
    Object.defineProperty(process, 'platform', { value: platform })
    mocks.openPath.mockResolvedValue('The directory could not be opened')

    await expect(openApplicationLogDirectory()).rejects.toThrow('The directory could not be opened')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
