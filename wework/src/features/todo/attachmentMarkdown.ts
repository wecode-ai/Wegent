export interface MarkdownAttachmentRow {
  id: string
  display_name: string
  size_bytes: number
}

const attachmentMarkdownPatterns = [
  /!?\[([^\]]+)\]\([^)]+\)\s*<!--\s*wegent-attachment:([A-Za-z0-9_-]+)\s*-->/g,
  /!?\[([^\]]+)\]\(wegent:\/\/attachments\/([A-Za-z0-9_-]+)\)/g,
]

export function markdownAttachmentRows(markdown: string): MarkdownAttachmentRow[] {
  return attachmentMarkdownPatterns.flatMap(pattern =>
    Array.from(markdown.matchAll(pattern), match => ({
      id: match[2],
      display_name: match[1],
      size_bytes: 0,
    }))
  )
}
