import { describe, expect, test, vi } from 'vitest'
import {
  BrowserAnnotationController,
  type BrowserElementAnchor,
} from './browser-annotation-controller.js'

const LABEL = 'workspace-browser'
const URL = 'https://example.com/page#section'

function anchor(selector = '#target'): BrowserElementAnchor {
  return {
    kind: 'element',
    pageUrl: URL,
    frameUrl: URL,
    framePath: [],
    selector,
    elementPath: ['html', 'body', 'button'],
    tagName: 'button',
    role: 'button',
    name: 'Target',
    immediateText: 'Target',
    nearbyText: 'Target nearby copy',
    rect: { x: 20, y: 30, width: 120, height: 40 },
    fixedPosition: false,
    scrollContainers: [],
  }
}

function harness() {
  const sent: Array<{ channel: string; payload: unknown }> = []
  const states: unknown[] = []
  const browser = {
    capture: vi.fn().mockResolvedValue('data:image/png;base64,c2NyZWVuc2hvdA=='),
    labelForContentsId: vi.fn().mockReturnValue(LABEL),
    send: vi.fn((_label: string, channel: string, payload: unknown) => {
      sent.push({ channel, payload })
    }),
    state: vi.fn().mockReturnValue({ title: 'Example', url: URL }),
  }
  const controller = new BrowserAnnotationController({
    browser,
    publish: state => states.push(state),
  })
  controller.handleRuntimeEvent(7, {
    type: 'runtime-ready',
    pageSessionId: 'page-session-1',
    pageUrl: URL,
    title: 'Example',
  })
  return { browser, controller, sent, states }
}

describe('BrowserAnnotationController', () => {
  test('owns comment state outside the page and restores it after reload', async () => {
    const { browser, controller, sent } = harness()

    controller.start(LABEL, 'batch')
    controller.handleRuntimeEvent(7, { type: 'create-draft', anchor: anchor() })
    await vi.waitFor(() => expect(browser.capture).toHaveBeenCalledOnce())
    await controller.saveDraft({
      comment: 'Keep this attached',
      designChanges: [],
    })

    const saved = controller.state(LABEL)
    expect(saved.comments).toHaveLength(1)
    expect(saved.comments[0]).toMatchObject({
      number: 1,
      comment: 'Keep this attached',
      screenshotDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
    })

    controller.handleRuntimeEvent(7, {
      type: 'runtime-ready',
      pageSessionId: 'page-session-2',
      pageUrl: 'https://example.com/page',
      title: 'Example reloaded',
    })

    expect(controller.state(LABEL).comments[0]?.id).toBe(saved.comments[0]?.id)
    expect(browser.send).toHaveBeenLastCalledWith(
      LABEL,
      'wework:browser-annotation-command',
      expect.objectContaining({
        type: 'sync',
        state: expect.objectContaining({
          comments: expect.arrayContaining([
            expect.objectContaining({ id: saved.comments[0]?.id }),
          ]),
        }),
      })
    )
    const runtimeComment = (
      sent.at(-1)?.payload as {
        state?: { comments?: Array<Record<string, unknown>> }
      }
    ).state?.comments?.[0]
    expect(runtimeComment).not.toHaveProperty('comment')
    expect(runtimeComment).not.toHaveProperty('screenshotDataUrl')
  })

  test('exits annotation mode and closes a stale draft after real navigation', async () => {
    const { controller, sent } = harness()
    controller.start(LABEL, 'batch')
    controller.setOriginalView(LABEL, true)
    controller.handleRuntimeEvent(7, { type: 'create-draft', anchor: anchor() })
    await vi.waitFor(() =>
      expect(
        (
          sent.at(-1)?.payload as {
            state?: { draft?: unknown }
          }
        ).state?.draft
      ).not.toBeNull()
    )

    controller.handleRuntimeEvent(7, {
      type: 'runtime-ready',
      pageSessionId: 'page-session-2',
      pageUrl: 'https://example.com/other',
      title: 'Other page',
    })

    expect(controller.state(LABEL)).toMatchObject({
      mode: 'off',
      originalView: false,
      comments: [],
    })
    expect(
      (
        sent.at(-1)?.payload as {
          state?: { draft?: unknown }
        }
      ).state?.draft
    ).toBeNull()
  })

  test('replaces an anchor without changing comment identity', async () => {
    const { browser, controller, states } = harness()
    controller.start(LABEL, 'batch')
    controller.handleRuntimeEvent(7, { type: 'create-draft', anchor: anchor() })
    await vi.waitFor(() => expect(browser.capture).toHaveBeenCalledOnce())
    await controller.saveDraft({ comment: 'Follow replacement', designChanges: [] })
    const comment = controller.state(LABEL).comments[0]

    controller.handleRuntimeEvent(7, {
      type: 'anchors-updated',
      unresolvedIds: [],
      anchors: [{ commentId: comment.id, anchor: anchor('#replacement') }],
    })

    expect(controller.state(LABEL).comments[0]).toMatchObject({
      id: comment.id,
      anchor: { selector: '#replacement' },
    })

    const publishedCount = states.length
    controller.handleRuntimeEvent(7, {
      type: 'anchors-updated',
      unresolvedIds: [],
      anchors: [
        {
          commentId: comment.id,
          anchor: {
            ...anchor('#replacement'),
            rect: { x: 200, y: 300, width: 120, height: 40 },
          },
        },
      ],
    })

    expect(states).toHaveLength(publishedCount)
  })

  test('persists design changes and supports original-view commands', async () => {
    const { browser, controller, sent } = harness()
    controller.start(LABEL, 'batch')
    controller.handleRuntimeEvent(7, {
      type: 'create-draft',
      anchor: anchor(),
      designValues: { color: 'rgb(17, 24, 39)' },
    })
    await vi.waitFor(() =>
      expect(
        (
          sent.at(-1)?.payload as {
            state?: { draft?: { designValues?: Record<string, string> } | null }
          }
        ).state?.draft?.designValues
      ).toEqual({ color: 'rgb(17, 24, 39)' })
    )
    await controller.saveDraft({
      comment: 'Make it red',
      designChanges: [{ property: 'color', value: '#ef4444', previousValue: 'rgb(17, 24, 39)' }],
    })

    expect(controller.state(LABEL).comments[0]?.designChanges).toEqual([
      { property: 'color', value: '#ef4444', previousValue: 'rgb(17, 24, 39)' },
    ])
    controller.setOriginalView(LABEL, true)
    expect(browser.send).toHaveBeenCalledWith(
      LABEL,
      'wework:browser-annotation-command',
      expect.objectContaining({
        type: 'sync',
        state: expect.objectContaining({ originalView: true }),
      })
    )

    controller.stop(LABEL)
    expect(controller.state(LABEL).originalView).toBe(false)
    expect(browser.send).toHaveBeenLastCalledWith(
      LABEL,
      'wework:browser-annotation-command',
      expect.objectContaining({
        type: 'sync',
        state: expect.objectContaining({
          mode: 'off',
          originalView: false,
        }),
      })
    )
  })

  test('accepts a design-only annotation with an empty comment', async () => {
    const { browser, controller } = harness()
    controller.start(LABEL, 'batch')
    controller.handleRuntimeEvent(7, {
      type: 'create-draft',
      anchor: anchor(),
      designValues: { color: 'rgb(17, 24, 39)' },
    })
    await vi.waitFor(() => expect(browser.capture).toHaveBeenCalledOnce())

    await controller.saveDraft({
      comment: '',
      designChanges: [{ property: 'color', value: '#ef4444', previousValue: 'rgb(17, 24, 39)' }],
    })

    expect(controller.state(LABEL).comments[0]).toMatchObject({
      comment: '',
      designChanges: [{ property: 'color', value: '#ef4444' }],
    })
  })

  test('accepts editor actions from the page runtime', async () => {
    const { controller } = harness()
    controller.start(LABEL, 'batch')
    controller.handleRuntimeEvent(7, { type: 'create-draft', anchor: anchor() })
    controller.handleRuntimeEvent(7, {
      type: 'save-draft',
      comment: 'Saved from the page',
      designChanges: [],
    })
    await vi.waitFor(() =>
      expect(controller.state(LABEL).comments[0]?.comment).toBe('Saved from the page')
    )
    const commentId = controller.state(LABEL).comments[0]?.id

    controller.handleRuntimeEvent(7, { type: 'open-comment', commentId, anchor: anchor() })
    controller.handleRuntimeEvent(7, { type: 'delete-draft' })
    expect(controller.state(LABEL).comments).toEqual([])
  })
})
