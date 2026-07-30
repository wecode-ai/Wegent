const MARKDOWN_FILE_PATTERN = /\.(?:md|markdown)$/i

export function isMarkdownFile(path: string): boolean {
  return MARKDOWN_FILE_PATTERN.test(path)
}
