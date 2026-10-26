// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { IssueDeliveryRow } from './IssueDeliveryRow'
import { IssueDeliveries } from './IssueExecutionLists'
import type { SharedIssueDetailDeliveryDetail } from './createSharedIssueDetailPort'

const translate = createCollaborationTranslator('zh-CN')
const delivery: SharedIssueDetailDeliveryDetail = {
  id: 'batch-1',
  loop_item_id: 'issue-1',
  created_by_user_id: 8,
  status: 'delivered',
  created_at: '2026-10-26T00:00:00Z',
  delivered_at: '2026-10-26T01:23:00Z',
  markdown: '# 分析报告',
  chat: { messages: [{ role: 'assistant', content: 'Result' }] },
  assets: [
    {
      id: 'asset-1',
      kind: 'file',
      display_name: '报告.pdf',
      relative_path: 'reports/报告.pdf',
      content_type: 'application/pdf',
      size_bytes: 123,
      sha256: 'abc',
    },
  ],
  fulfillments: [],
}
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('distinguishes multiple batches by contents, files, authors and time', async () => {
  const onOpen = vi.fn()
  const getDelivery = vi.fn()
  await act(async () =>
    root.render(
      <IssueDeliveries
        deliveries={[
          delivery,
          {
            ...delivery,
            id: 'batch-2',
            created_by_user_id: 9,
            markdown: '',
            chat: {
              messages: [
                { role: 'user', content: 'A' },
                { role: 'assistant', content: 'B' },
              ],
            },
            assets: [],
          },
        ]}
        getDelivery={getDelivery}
        memberName={id => (id === 8 ? '张三' : '李四')}
        onOpen={onOpen}
        translate={translate}
      />
    )
  )
  const rows = container.querySelectorAll<HTMLButtonElement>(
    '[data-testid^="todo-detail-open-delivery-"]'
  )
  expect(rows).toHaveLength(2)
  expect(rows[0].textContent).toContain('交付说明 · 1 条消息 · 1 个附件')
  expect(rows[0].textContent).toContain('报告.pdf')
  expect(rows[0].textContent).toContain('分析报告')
  expect(rows[0].textContent).toContain('张三 交付')
  expect(rows[0].querySelector('time')?.dateTime).toBe(delivery.delivered_at)
  expect(rows[1].textContent).toContain('2 条消息')
  expect(rows[1].textContent).toContain('李四 交付')
  expect(rows[1].textContent).not.toContain('交付说明')
  await act(async () => rows[1].click())
  expect(onOpen).toHaveBeenCalledWith('batch-2')
  expect(getDelivery).not.toHaveBeenCalled()
})

it('loads missing content once and retains creator metadata from the list', async () => {
  let resolve!: (value: SharedIssueDetailDeliveryDetail) => void
  const getDelivery = vi.fn(
    () =>
      new Promise<SharedIssueDetailDeliveryDetail>(done => {
        resolve = done
      })
  )
  const props = {
    delivery: { ...delivery, markdown: undefined, chat: undefined },
    getDelivery,
    memberName: () => null,
    onOpen: vi.fn(),
    translate,
  }
  await act(async () => root.render(<IssueDeliveryRow {...props} />))
  expect(container.textContent).toContain('正在加载内容')
  expect(container.textContent).toContain('用户 #8 交付')
  await act(async () => resolve(delivery))
  expect(container.textContent).toContain('交付说明 · 1 条消息 · 1 个附件')
  await act(async () => root.render(<IssueDeliveryRow {...props} memberName={() => '张三'} />))
  expect(container.textContent).toContain('张三 交付')
  expect(getDelivery).toHaveBeenCalledTimes(1)
})

it('reports loading failure while keeping known files and author visible', async () => {
  await act(async () =>
    root.render(
      <IssueDeliveryRow
        delivery={{ ...delivery, markdown: undefined, chat: undefined }}
        getDelivery={vi.fn().mockRejectedValue(new Error('unavailable'))}
        memberName={() => '张三'}
        onOpen={vi.fn()}
        translate={translate}
      />
    )
  )
  expect(container.textContent).toContain('内容加载失败，点击查看')
  expect(container.textContent).toContain('报告.pdf')
  expect(container.textContent).toContain('张三 交付')
  expect(container.textContent).not.toContain('无交付内容')
})
