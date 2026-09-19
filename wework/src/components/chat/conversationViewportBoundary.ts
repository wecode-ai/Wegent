export function getCodeCommentPreviewRightBoundary() {
  const panel = document.querySelector('[data-testid="right-workspace-panel"]')
  const rect = panel?.getBoundingClientRect()
  return rect && rect.width > 1 ? rect.left : window.innerWidth - 8
}
