import { expect, test, vi } from 'vitest'
import { listEmbeddedBrowserDownloads } from '@/lib/embedded-browser'
import { createBrowserDownloads } from './workspaceBrowserDownloads'
import {
  createBrowserSessionInitial,
  type BrowserSessionModel,
  type BrowserSessionOptions,
} from './workspaceBrowserSessionTypes'

vi.mock('@/lib/embedded-browser', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/embedded-browser')>()),
  listEmbeddedBrowserDownloads: vi.fn(),
}))

test.each(['a closed panel', 'an inactive tab'])(
  'clearing history settles a pending download read in %s',
  async surface => {
    const options = { active: true, label: 'test-browser' } as BrowserSessionOptions
    const { state, runtime } = createBrowserSessionInitial(options)
    const model = {
      state,
      runtime,
      options,
      observed: true,
      set(key, update) {
        state[key] = typeof update === 'function' ? update(state[key]) : update
      },
    } satisfies Pick<BrowserSessionModel, 'state' | 'runtime' | 'options' | 'observed' | 'set'>
    const downloads = createBrowserDownloads(model as BrowserSessionModel)
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof listEmbeddedBrowserDownloads>>>()
    vi.mocked(listEmbeddedBrowserDownloads).mockReturnValueOnce(reply.promise)
    state.downloadsOpen = true
    const refresh = downloads.refreshDownloads()
    try {
      expect(state.downloadsLoading).toBe(true)
      if (surface === 'a closed panel') state.downloadsOpen = false
      else options.active = false
      downloads.clearDownloadHistory(2)
      expect(state.downloadsLoading).toBe(false)
    } finally {
      reply.resolve({
        revision: 1,
        downloads: [],
        historyUnavailable: true,
        historyReadFailed: true,
      })
      await refresh
    }
    expect(state.downloadsLoading).toBe(false)
    expect(state.downloadsError).toBe(false)
  }
)
