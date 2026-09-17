// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TemporaryConversationLayout } from './TemporaryConversationLayout'
import { createCollaborationTranslator } from '../i18n'

describe('shared temporary conversation layout', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })
  function render(count: number) {
    act(() =>
      root.render(
        <TemporaryConversationLayout
          messageCount={count}
          emptyStateText="暂无会话消息"
          translate={createCollaborationTranslator('zh-CN')}
          composer={<textarea defaultValue="保留草稿" />}
        >
          <div data-testid="message-area">消息区域</div>
        </TemporaryConversationLayout>
      )
    )
  }
  it('shows the PC empty state even when the host supplies a message-area element', () => {
    render(0)
    expect(container.textContent).toContain('暂无会话消息')
    expect(container.querySelector('[data-testid="message-area"]')).toBeNull()
    expect(container.querySelector('textarea')?.value).toBe('保留草稿')
  })
  it('replaces the empty state with messages without remounting the composer', () => {
    render(0)
    const input = container.querySelector('textarea')!
    input.value = '尚未发送'
    render(1)
    expect(container.textContent).not.toContain('暂无会话消息')
    expect(container.querySelector('[data-testid="message-area"]')).not.toBeNull()
    expect(container.querySelector('textarea')).toBe(input)
    expect(input.value).toBe('尚未发送')
  })
})
