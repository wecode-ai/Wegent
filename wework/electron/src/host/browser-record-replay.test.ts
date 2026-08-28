import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WebContents } from 'electron'
import { describe, expect, test, vi } from 'vitest'
import { temporaryDirectory } from '../runtime/test-helpers.js'
import { BrowserRecordReplay } from './browser-record-replay.js'

describe('browser record replay', () => {
  test('stores low-risk actions and replaces sensitive values with a handoff', async () => {
    const root = await temporaryDirectory('browser-record-replay-')
    const events = [
      {
        type: 'fill',
        timestamp: Date.now(),
        target: { selector: '#query', role: 'input', name: 'Search' },
        value: 'Wegent',
      },
      {
        type: 'fill',
        timestamp: Date.now(),
        target: { selector: '#password', role: 'input', name: 'Password' },
        value: 'secret',
      },
      {
        type: 'fill',
        timestamp: Date.now(),
        target: { selector: '#contact', role: 'input', name: 'Contact' },
        value: 'person@example.com',
      },
    ]
    const contents = fakeContents(events)
    const recorder = new BrowserRecordReplay(
      root.path,
      () => contents,
      vi.fn(async () => undefined)
    )

    await recorder.start('Search flow', 'workspace-browser')
    const recording = await recorder.stop()

    expect(recording.steps).toMatchObject([
      { type: 'navigate', url: 'https://example.test/' },
      { type: 'fill', value: 'Wegent', replayable: true },
      {
        type: 'fill',
        value: '{{USER_INPUT_REQUIRED}}',
        replayable: false,
        reason: 'Sensitive value was not stored',
      },
      {
        type: 'fill',
        value: '{{USER_INPUT_REQUIRED}}',
        replayable: false,
        reason: 'Sensitive value was not stored',
      },
    ])
    const persisted = JSON.parse(
      await readFile(join(root.path, 'browser-recordings', 'recordings.json'), 'utf8')
    )
    expect(persisted.recordings).toHaveLength(1)
    await root.remove()
  })

  test('replays navigation and DOM actions in order', async () => {
    const root = await temporaryDirectory('browser-record-replay-')
    const contents = fakeContents([
      {
        type: 'click',
        timestamp: Date.now(),
        target: { selector: '#submit', role: 'button', name: 'Search' },
      },
    ])
    const navigate = vi.fn(async () => undefined)
    const recorder = new BrowserRecordReplay(root.path, () => contents, navigate)
    await recorder.start('Replay flow', 'workspace-browser')
    const recording = await recorder.stop()
    contents.executeJavaScript.mockResolvedValue(true)

    await recorder.replay(recording.id, 'workspace-browser')
    await vi.waitFor(() => expect(recorder.status().phase).toBe('idle'))

    expect(navigate).toHaveBeenCalledWith('workspace-browser', 'https://example.test/')
    expect(contents.executeJavaScript).toHaveBeenCalledWith(
      expect.stringContaining("step.type === 'click'"),
      true
    )
    await root.remove()
  })

  test('pauses before a high-risk action', async () => {
    const root = await temporaryDirectory('browser-record-replay-')
    const contents = fakeContents([
      {
        type: 'click',
        timestamp: Date.now(),
        target: { selector: '#delete', role: 'button', name: 'Delete account' },
      },
    ])
    const recorder = new BrowserRecordReplay(
      root.path,
      () => contents,
      vi.fn(async () => undefined)
    )
    await recorder.start('Risk flow', 'workspace-browser')
    const recording = await recorder.stop()

    await recorder.replay(recording.id, 'workspace-browser')
    await vi.waitFor(() => expect(recorder.status().phase).toBe('paused'))

    expect(recorder.status().message).toContain('confirmation')
    recorder.cancel()
    expect(recorder.status().phase).toBe('idle')
    await root.remove()
  })
})

function fakeContents(events: unknown[]) {
  let drained = false
  return {
    getURL: vi.fn(() => 'https://example.test/'),
    isDestroyed: vi.fn(() => false),
    executeJavaScript: vi.fn(async (expression: string) => {
      if (expression.includes('__WEWORK_RECORD_REPLAY__?.drain')) {
        if (drained) return []
        drained = true
        return events
      }
      return true
    }),
  } as unknown as WebContents & {
    executeJavaScript: ReturnType<typeof vi.fn>
  }
}
