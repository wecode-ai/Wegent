const PANEL_RESIZING_ATTRIBUTE = 'data-wework-panel-resizing'

// Embedded browser surfaces (<webview> or iframe fallback) swallow pointer
// events while the cursor is over them, which stalls document-level panel
// resize drags. Flag active drags on <body> so global CSS can temporarily
// disable pointer events on those surfaces.
export function setPanelResizeShieldActive(active: boolean): void {
  if (active) {
    document.body.setAttribute(PANEL_RESIZING_ATTRIBUTE, 'true')
    return
  }
  document.body.removeAttribute(PANEL_RESIZING_ATTRIBUTE)
}
