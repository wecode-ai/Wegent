import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { openInExternalBrowser } from './external-browser.js'

const mocks = vi.hoisted(() => ({
  application: vi.fn(),
  openExternal: vi.fn(),
  launch: vi.fn(),
  execute: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { getApplicationInfoForProtocol: mocks.application },
  shell: { openExternal: mocks.openExternal },
}))
vi.mock('./local-workspace-openers.js', () => ({ launchDetached: mocks.launch }))
vi.mock('node:child_process', () => ({ execFile: mocks.execute }))

describe('explicit external browser opening', () => {
  let directory: string
  let file: string

  beforeEach(async () => {
    vi.resetAllMocks()
    mocks.application.mockResolvedValue({ path: '/browser/executable' })
    mocks.execute.mockImplementation((_command, _args, _options, callback) => callback(null, ''))
    directory = await mkdtemp(join(tmpdir(), 'wework-external-browser-'))
    file = join(directory, '文件 with spaces & $.txt')
    await writeFile(file, 'External browser fixture')
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  test.each(['http://localhost:3000/', 'https://example.com/'])(
    'keeps web URL %s on the existing OS browser path',
    async url => {
      await openInExternalBrowser(url)
      expect(mocks.openExternal).toHaveBeenCalledWith(url)
      expect(mocks.application).not.toHaveBeenCalled()
    }
  )

  test.each(['linux', 'win32'])(
    'passes file and directory URLs to the HTTPS browser executable on %s',
    async platform => {
      vi.stubGlobal('process', { ...process, platform })
      const nested = join(directory, 'nested folder')
      await mkdir(nested)
      for (const path of [file, nested]) {
        const url = pathToFileURL(path).href
        await openInExternalBrowser(url)
        expect(mocks.launch).toHaveBeenLastCalledWith('/browser/executable', [url])
      }
      expect(mocks.application).toHaveBeenCalledWith('https://example.com')
      expect(mocks.openExternal).not.toHaveBeenCalled()
      expect(mocks.execute).not.toHaveBeenCalled()
    }
  )

  test('selects the HTTPS application explicitly on macOS for both files and directories', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    mocks.application.mockResolvedValue({ path: '/Applications/Browser.app' })
    for (const path of [file, directory]) {
      await openInExternalBrowser(pathToFileURL(path).href)
      expect(mocks.execute).toHaveBeenLastCalledWith(
        '/usr/bin/open',
        ['-a', '/Applications/Browser.app', pathToFileURL(path).href],
        { timeout: 10_000 },
        expect.any(Function)
      )
    }
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  test.each(['mailto:user@example.com', 'javascript:alert(1)', 'file://remote/share/file.txt'])(
    'rejects unsupported targets without launching an application: %s',
    async url => {
      await expect(openInExternalBrowser(url)).rejects.toThrow()
      expect(mocks.application).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled()
      expect(mocks.execute).not.toHaveBeenCalled()
    }
  )

  test('reports a missing target and recovers after it is restored', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const url = pathToFileURL(file).href
    await rm(file)
    await expect(openInExternalBrowser(url)).rejects.toThrow()
    expect(mocks.application).not.toHaveBeenCalled()
    await writeFile(file, 'Restored file')
    await openInExternalBrowser(url)
    expect(mocks.launch).toHaveBeenCalledWith('/browser/executable', [url])
  })

  test('propagates browser discovery and launch errors without using a file-type handler', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    const url = pathToFileURL(file).href
    mocks.application.mockRejectedValueOnce(new Error('No browser configured'))
    await expect(openInExternalBrowser(url)).rejects.toThrow('No browser configured')
    expect(mocks.launch).not.toHaveBeenCalled()
    mocks.launch.mockRejectedValueOnce(new Error('Browser launch failed'))
    await expect(openInExternalBrowser(url)).rejects.toThrow('Browser launch failed')
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })

  test('fails when browser discovery returns no executable path', async () => {
    mocks.application.mockResolvedValue({ path: '' })
    await expect(openInExternalBrowser(pathToFileURL(file).href)).rejects.toThrow(
      'No default external browser'
    )
    expect(mocks.openExternal).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.launch).not.toHaveBeenCalled()
  })

  test('reports macOS browser launch failures', async () => {
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    mocks.execute.mockImplementation((_command, _args, _options, callback) =>
      callback(new Error('Browser cannot be opened'))
    )
    await expect(openInExternalBrowser(pathToFileURL(file).href)).rejects.toThrow(
      'Browser cannot be opened'
    )
    expect(mocks.openExternal).not.toHaveBeenCalled()
  })
})
