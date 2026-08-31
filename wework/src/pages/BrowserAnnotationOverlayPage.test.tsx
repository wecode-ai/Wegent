import { act, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { BrowserAnnotationOverlayState } from '@/types/browser-annotation'
import { BrowserAnnotationOverlayPage } from './BrowserAnnotationOverlayPage'

const embeddedBrowserMocks = vi.hoisted(() => ({
  closeEmbeddedBrowserAnnotationDraft: vi.fn(),
  deleteEmbeddedBrowserAnnotationDraft: vi.fn(),
  listenEmbeddedBrowserAnnotationOverlayState: vi.fn(),
  readEmbeddedBrowserAnnotationOverlayState: vi.fn(),
  resizeEmbeddedBrowserAnnotationOverlay: vi.fn(async () => undefined),
  saveEmbeddedBrowserAnnotationDraft: vi.fn(),
}))

vi.mock('@/lib/embedded-browser', () => embeddedBrowserMocks)

function overlayState(comment: string): BrowserAnnotationOverlayState {
  return {
    open: true,
    draft: {
      label: 'workspace-browser',
      commentId: 'annotation-1',
      anchor: {
        kind: 'element',
        pageUrl: 'https://example.com/',
        frameUrl: 'https://example.com/',
        framePath: [],
        selector: '#target',
        elementPath: ['html', 'body', 'button#target'],
        tagName: 'button',
        name: 'Target',
        rect: { x: 20, y: 30, width: 120, height: 40 },
        fixedPosition: false,
        scrollContainers: [],
      },
      comment,
      designChanges: [],
      designValues: {},
      textChange: null,
      screenshotDataUrl: null,
      screenshotState: 'failed',
    },
  }
}

describe('BrowserAnnotationOverlayPage', () => {
  test('keeps listener state when the initial read resolves later', async () => {
    let resolveInitialState: (state: BrowserAnnotationOverlayState) => void = () => undefined
    let publishState: ((state: BrowserAnnotationOverlayState) => void) | undefined
    embeddedBrowserMocks.readEmbeddedBrowserAnnotationOverlayState.mockReturnValue(
      new Promise(resolve => {
        resolveInitialState = resolve
      })
    )
    embeddedBrowserMocks.listenEmbeddedBrowserAnnotationOverlayState.mockImplementation(handler => {
      publishState = handler
      return Promise.resolve(() => undefined)
    })

    render(<BrowserAnnotationOverlayPage />)
    act(() => publishState?.(overlayState('Listener state')))
    expect(screen.getByTestId('browser-annotation-comment-input')).toHaveValue('Listener state')

    await act(async () => {
      resolveInitialState({ open: false, draft: null })
      await Promise.resolve()
    })

    expect(screen.getByTestId('browser-annotation-comment-input')).toHaveValue('Listener state')
    expect(screen.getByTestId('browser-annotation-cancel-button')).toBeInTheDocument()
  })
})
