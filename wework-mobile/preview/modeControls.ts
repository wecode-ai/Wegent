export type PreviewMode = 'preview' | 'source'

export const previewModeStyles = `
  :host { display: block; height: 52px; flex: 0 0 52px; }
  * { box-sizing: border-box; }
  .modes { display: flex; width: 200px; max-width: 100%; height: 44px; margin: 0 auto;
    position: relative; font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  .modes::before { content: ''; position: absolute; inset: 6px 0;
    background: #e8e8ed; border-radius: 22px; }
  button { appearance: none; border: 0; padding: 8px 2px; margin: 0; background: none;
    flex: 1; min-width: 44px; min-height: 44px; color: #636366; font: inherit;
    cursor: pointer; position: relative; touch-action: manipulation; }
  span { display: grid; place-items: center; height: 28px; border-radius: 20px; }
  [aria-selected='true'] { color: #1c1c1e; }
  [aria-selected='true'] span { background: #fff; }
  :host([data-theme='dark']) .modes::before { background: #36363b; }
  :host([data-theme='dark']) button { color: #b8b8be; }
  :host([data-theme='dark']) [aria-selected='true'] { color: #ececef; }
  :host([data-theme='dark']) [aria-selected='true'] span { background: #1c1c1e; }
`

/** Self-contained so the same isolated controls can run inside the HTML sandbox. */
export function mountPreviewModes(
  host: HTMLElement,
  mode: PreviewMode,
  theme: 'light' | 'dark',
  onChange: (mode: PreviewMode) => void,
  styles: string
) {
  host.dataset.testid = 'file-preview-modes'
  host.dataset.theme = theme
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const document = host.ownerDocument
  const style = document.createElement('style')
  style.textContent = styles
  const group = document.createElement('div')
  group.className = 'modes'
  group.setAttribute('role', 'tablist')
  group.setAttribute('aria-label', '文件显示方式')
  for (const [value, label] of [
    ['preview', '预览'],
    ['source', '源码'],
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(value === mode))
    button.dataset.testid = `file-mode-${value}`
    const text = document.createElement('span')
    text.textContent = label
    button.append(text)
    button.addEventListener('click', () => onChange(value))
    group.append(button)
  }
  shadow.replaceChildren(style, group)
}
