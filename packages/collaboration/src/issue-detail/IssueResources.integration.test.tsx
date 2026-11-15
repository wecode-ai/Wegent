// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { IssueActivityMarkdown } from './IssueActivityMarkdown'
import { IssueMarkdownProvider } from './IssueMarkdownProvider'
import { createCollaborationTranslator } from '../i18n'
import type { SharedWorkspaceAttachmentsApi } from '../ports/SharedWorkspaceApi'

let root: Root
let container: HTMLDivElement
const translate = createCollaborationTranslator('zh-CN')
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn().mockReturnValue('blob:issue-image')
      static revokeObjectURL = vi.fn()
    }
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fixture() {
  const list = vi.fn().mockResolvedValue([
    {
      id: 'image-uuid',
      display_name: 'chart.png',
      content_type: 'image/png',
    },
  ])
  const read = vi.fn().mockResolvedValue(new Blob(['png'], { type: 'application/octet-stream' }))
  const open = vi.fn()
  const api = { list, read } as unknown as SharedWorkspaceAttachmentsApi
  return { list, read, open, api }
}
function render(
  api: SharedWorkspaceAttachmentsApi,
  content: string,
  open = vi.fn(),
  issueId = 'issue-6'
) {
  return act(async () =>
    root.render(
      <IssueMarkdownProvider attachments={api} issueId={issueId} onOpenAttachment={open}>
        <IssueActivityMarkdown content={content} translate={translate} />
      </IssueMarkdownProvider>
    )
  )
}

it.each([
  'wegent://attachments/image-uuid',
  '/api/v1/loop-item-attachments/image-uuid/content',
  '/home/ubuntu/outputs/chart.png',
  './images/chart.png',
  'file:///home/ubuntu/chart.png',
  'C:\\outputs\\chart.png',
])('loads and opens %s through the Issue resource service', async src => {
  const { api, list, read, open } = fixture()
  await render(api, `![图表](${src})`, open)
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:issue-image')
  expect(read).toHaveBeenCalledExactlyOnceWith('image-uuid')
  expect(list).toHaveBeenCalledWith('issue-6')
  expect(vi.mocked(URL.createObjectURL).mock.calls[0][0].type).toBe('image/png')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assistant-markdown-image-open"]')!
      .click()
  )
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'image-uuid', display_name: 'chart.png' })
  )
  await render(api, 'Done', open)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:issue-image')
})

it('reports missing images and retries only after a user action', async () => {
  const { api, list, read } = fixture()
  list.mockResolvedValueOnce([])
  await render(api, '![图表](/remote/chart.png)')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('图片加载失败')
  expect(read).not.toHaveBeenCalled()
  expect(list).toHaveBeenCalledTimes(1)
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assistant-markdown-image-retry"]')!
      .click()
  )
  expect(container.querySelector('img')?.src).toBe('blob:issue-image')
  expect(read).toHaveBeenCalledOnce()
})

it('keeps external images external and exposes decoding failures with recovery', async () => {
  const { api, list, read } = fixture()
  await render(api, '![Web](https://example.test/chart.png)')
  expect(container.querySelector('img')?.src).toBe('https://example.test/chart.png')
  expect(list).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
  await act(async () => container.querySelector('img')!.dispatchEvent(new Event('error')))
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('图片加载失败')
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="assistant-markdown-image-retry"]')!
      .click()
  )
  expect(container.querySelector('img')?.src).toBe('https://example.test/chart.png')
})

it('does not reuse an image when the same reference moves to another Issue', async () => {
  const { api, list, read, open } = fixture()
  await render(api, '![chart.png](/remote/chart.png)', open, 'first')
  let complete!: (rows: unknown[]) => void
  list.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        complete = resolve
      })
  )
  await render(api, '![chart.png](/remote/chart.png)', open, 'second')
  expect(container.querySelector('img')).toBeNull()
  expect(container.querySelector('[data-testid="assistant-markdown-image-loading"]')).not.toBeNull()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:issue-image')
  await act(async () =>
    complete([
      {
        id: 'second-image',
        display_name: 'chart.png',
        content_type: 'image/png',
      },
    ])
  )
  expect(read).toHaveBeenLastCalledWith('second-image')
  expect(container.querySelector('img')).not.toBeNull()
})

it('rejects an image response that is actually HTML', async () => {
  const { api, read } = fixture()
  read.mockResolvedValue(new Blob(['<script>bad()</script>'], { type: 'text/html' }))
  await render(api, '![chart.png](wegent://attachments/image-uuid)')
  expect(container.querySelector('img, script, iframe')).toBeNull()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('图片加载失败')
})

it('preserves linked images without nesting interactive controls', async () => {
  const { api, open } = fixture()
  await render(
    api,
    '[![chart.png](wegent://attachments/image-uuid)](wegent://attachments/image-uuid)',
    open
  )
  expect(container.querySelector('img')?.src).toBe('blob:issue-image')
  expect(container.querySelector('button button')).toBeNull()
  await act(async () =>
    container
      .querySelector<HTMLButtonElement>('[data-testid="issue-comment-attachment-image-uuid"]')!
      .click()
  )
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'image-uuid' }))
})
