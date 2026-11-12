import type { DownloadItem, Session, WebContents } from 'electron'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, test, vi } from 'vitest'
import { installE2EBrowserDownloads } from './e2e-browser-downloads.js'

afterEach(() => vi.restoreAllMocks())

function fixture(environment: NodeJS.ProcessEnv = {}) {
  let download!: (event: unknown, item: DownloadItem, contents: WebContents) => void
  const on = vi.fn(
    (
      _event: string,
      listener: (event: unknown, item: DownloadItem, contents: WebContents) => void
    ) => {
      download = listener
    }
  )
  const setPath = vi.fn()
  installE2EBrowserDownloads({
    environment,
    app: { setPath },
    session: { on } as unknown as Pick<Session, 'on'>,
    isHostWindow: id => id === 7,
  })
  const item = {
    getFilename: vi.fn(() => 'same-name.txt'),
    setSavePath: vi.fn(),
    cancel: vi.fn(),
    once: vi.fn<(event: 'done', listener: (event: unknown, state: string) => void) => void>(),
  }
  return {
    on,
    setPath,
    item,
    download: (id: number) =>
      download(null, item as unknown as DownloadItem, { id } as WebContents),
  }
}

const environment = {
  VITE_WEWORK_E2E: 'true',
  WEWORK_E2E_CONTROL_URL: 'http://127.0.0.1:1234',
  WEWORK_E2E_DOWNLOADS_DIR: join(tmpdir(), 'isolated-group-downloads'),
}

test.each(['VITE_WEWORK_E2E', 'WEWORK_E2E_CONTROL_URL', 'WEWORK_E2E_DOWNLOADS_DIR'])(
  'does not change native downloads without %s',
  field => {
    const f = fixture({ ...environment, [field]: '' })
    expect(f.on).not.toHaveBeenCalled()
    expect(f.setPath).not.toHaveBeenCalled()
  }
)

test('configures the actual host download and records native completion without private fields', () => {
  const f = fixture(environment)
  const output = vi.spyOn(console, 'info').mockImplementation(() => {})
  f.download(7)
  expect(f.setPath).toHaveBeenCalledExactlyOnceWith(
    'downloads',
    resolve(environment.WEWORK_E2E_DOWNLOADS_DIR)
  )
  expect(f.item.setSavePath).toHaveBeenCalledExactlyOnceWith(
    join(environment.WEWORK_E2E_DOWNLOADS_DIR, 'same-name.txt')
  )
  expect(f.item.cancel).not.toHaveBeenCalled()
  const [event, done] = f.item.once.mock.calls[0]!
  expect(event).toBe('done')
  done(null, 'completed')
  expect(output).toHaveBeenCalledExactlyOnceWith(
    '[Wework E2E] browser-download',
    '{"completed":true}'
  )
})

test('leaves non-host browser downloads on their original path', () => {
  const f = fixture(environment)
  f.download(8)
  expect(f.item.getFilename).not.toHaveBeenCalled()
  expect(f.item.setSavePath).not.toHaveBeenCalled()
  expect(f.item.cancel).not.toHaveBeenCalled()
})

test.each(['', '..', '../escape.txt', resolve(tmpdir(), 'escape.txt')])(
  'cancels a host destination outside its isolated filename: %s',
  filename => {
    const f = fixture(environment)
    f.item.getFilename.mockReturnValue(filename)
    f.download(7)
    expect(f.item.cancel).toHaveBeenCalledOnce()
    expect(f.item.setSavePath).not.toHaveBeenCalled()
    expect(f.item.once).not.toHaveBeenCalled()
  }
)
