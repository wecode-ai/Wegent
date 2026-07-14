export const WORKBENCH_NEW_CHAT_FOCUS_EVENT = 'wework:focus-new-chat-composer'

export function requestNewChatComposerFocus() {
  window.requestAnimationFrame(() => {
    window.dispatchEvent(new Event(WORKBENCH_NEW_CHAT_FOCUS_EVENT))
  })
}
