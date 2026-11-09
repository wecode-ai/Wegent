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
  function render(count: number, showWorkbenchBackground = false, loading = false) {
    act(() =>
      root.render(
        <TemporaryConversationLayout
          messageCount={count}
          loading={loading}
          emptyStateText="暂无会话消息"
          showWorkbenchBackground={showWorkbenchBackground}
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
  it('reports an unfinished history read while cached messages remain visible', () => {
    render(1, false, true)
    const owner = container.querySelector('[data-testid="right-workspace-chat-panel"]')!
    expect(owner.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-testid="message-area"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="temporary-conversation-loading"]')).toBeNull()
    const input = container.querySelector('textarea')!
    render(1, false, false)
    expect(owner.getAttribute('aria-busy')).toBe('false')
    expect(container.querySelector('textarea')).toBe(input)
  })
  it('keeps the composer surface translucent when the workbench background is visible', () => {
    render(0, true)

    const composerShell = container.querySelector(
      '[data-testid="right-workspace-chat-composer-shell"]'
    )
    expect(composerShell?.className).toContain('bg-transparent')
    expect(composerShell?.className).not.toContain('bg-background')
  })
  it('reports pending history while cached messages remain visible', () => {
    render(1, false, true)
    const panel = container.querySelector('[data-testid="right-workspace-chat-panel"]')!
    const composer = container.querySelector('textarea')
    expect(panel.getAttribute('aria-busy')).toBe('true')
    expect(container.querySelector('[data-testid="message-area"]')).not.toBeNull()

    render(1)

    expect(panel.getAttribute('aria-busy')).toBe('false')
    expect(container.querySelector('textarea')).toBe(composer)
  })
})
