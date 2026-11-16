import { afterEach, expect, test, vi } from 'vitest'
import {
  isConversationDiagnosticsEnabled,
  resetConversationDiagnosticsForTest,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import { runDesktopControlClient } from './automation'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  resetConversationDiagnosticsForTest()
})

test.each([true, false])(
  'verification diagnostics end with the control client: ready=%s',
  async ready => {
    vi.stubEnv('VITE_WEWORK_E2E', 'true')
    resetConversationDiagnosticsForTest()
    vi.stubGlobal('fetch', async (url: string) => {
      expect(isConversationDiagnosticsEnabled()).toBe(true)
      return url.endsWith('/ready')
        ? Response.json({}, { status: ready ? 200 : 500 })
        : new Response(null, { status: 410 })
    })
    const running = runDesktopControlClient('http://127.0.0.1:43111', 'main')
    if (ready) await running
    else await expect(running).rejects.toThrow('registration failed with 500')
    expect(isConversationDiagnosticsEnabled()).toBe(false)
  }
)
