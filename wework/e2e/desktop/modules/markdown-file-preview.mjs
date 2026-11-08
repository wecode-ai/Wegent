export async function assertMarkdownPreviewAndSource(control, text, options = {}) {
  await control.command('waitFor', '[data-testid="workspace-markdown-preview"]', {
    ...options,
    text,
  })
  await control.command('clickWhenEnabled', '[data-testid="workspace-file-markdown-mode-button"]')
  await control.command('waitFor', '[data-testid="workspace-file-editor-content"]', {
    ...options,
    text,
  })
}
