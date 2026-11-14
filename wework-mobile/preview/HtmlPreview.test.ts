import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HtmlPreview } from './HtmlPreview'
import { htmlDocumentWithReadingBridge } from './htmlDocument'

vi.mock('./htmlDocument', () => ({
  HTML_PREVIEW_SANDBOX: 'allow-forms allow-popups allow-scripts',
  htmlDocumentWithReadingBridge: vi.fn((text: string, theme: string) => `${theme}:${text}`),
}))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('HTML preview theme updates', () => {
  let renderer: ReactTestRenderer | undefined
  afterEach(async () => {
    if (renderer) await act(() => renderer!.unmount())
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the same iframe document and reading position when the theme changes', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const props = {
      text: '<p>Document</p>',
      name: 'document.html',
      search: '',
      theme: 'light' as const,
      initialPosition: 500,
      onPosition: vi.fn(),
      onModeChange: vi.fn(),
    }
    await act(() => {
      renderer = create(createElement(HtmlPreview, props), {
        createNodeMock: () => ({ contentWindow: { postMessage } }),
      })
    })
    const initialSrcDoc = renderer!.root.findByType('iframe').props.srcDoc
    postMessage.mockClear()

    await act(() => renderer!.update(createElement(HtmlPreview, { ...props, theme: 'dark' })))

    expect(renderer!.root.findByType('iframe').props.srcDoc).toBe(initialSrcDoc)
    expect(htmlDocumentWithReadingBridge).toHaveBeenCalledExactlyOnceWith(props.text, 'light')
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(
      { channel: 'wework-html-reading', type: 'theme', value: 'dark' },
      '*'
    )
    expect(props.onPosition).not.toHaveBeenCalled()
  })
})
