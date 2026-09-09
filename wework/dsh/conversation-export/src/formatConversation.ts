import type {
  WeworkConversationAttachment,
  WeworkConversationBlock,
  WeworkConversationItem,
  WeworkConversationSnapshot,
} from '../../app-wework/client'
import { renderMarkdownHtml } from './renderMarkdown'

export type ConversationExportFormat = 'markdown' | 'html'

export function formatConversation(
  snapshot: WeworkConversationSnapshot,
  format: ConversationExportFormat,
  exportedAt = new Date()
): string {
  return format === 'html'
    ? formatConversationHtml(snapshot, exportedAt)
    : formatConversationMarkdown(snapshot, exportedAt)
}

export function conversationExportFilename(
  title: string,
  format: ConversationExportFormat
): string {
  const base =
    [...title.trim()]
      .map(character => (character.charCodeAt(0) < 32 ? '-' : character))
      .join('')
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/[. ]+$/g, '')
      .slice(0, 80) || 'conversation'
  return `${base}.${format === 'html' ? 'html' : 'md'}`
}

function formatConversationMarkdown(
  snapshot: WeworkConversationSnapshot,
  exportedAt: Date
): string {
  const sections = [
    `# ${snapshot.title}`,
    `> Exported from Wework on ${exportedAt.toISOString()}${snapshot.complete ? '' : ' while the conversation was active'}`,
  ]
  for (const turn of snapshot.turns) {
    sections.push(itemsMarkdown(turn.items))
  }
  return `${sections.filter(Boolean).join('\n\n')}\n`
}

function itemsMarkdown(items: readonly WeworkConversationItem[]): string {
  const sections: string[] = []
  let processingBlocks: WeworkConversationBlock[] = []
  const flushProcessing = () => {
    if (processingBlocks.length === 0) return
    sections.push(processingGroupMarkdown(processingBlocks))
    processingBlocks = []
  }
  for (const item of items) {
    if (item.type === 'block' && ['thinking', 'tool', 'file_changes'].includes(item.block.type)) {
      processingBlocks.push(item.block)
      continue
    }
    flushProcessing()
    if (item.type === 'user_message') {
      const content = item.content.trim() ? `\n\n${item.content}` : ''
      const attachments =
        item.attachments.length > 0
          ? `\n\n${item.attachments.map(attachmentMarkdown).join('\n')}`
          : ''
      sections.push(`## User${content}${attachments}`)
    } else if (item.type === 'assistant_text') {
      sections.push(`## Assistant\n\n${item.content}`)
    } else {
      sections.push(formatBlockMarkdown(item.block))
    }
  }
  flushProcessing()
  return sections.filter(Boolean).join('\n\n')
}

function processingGroupMarkdown(blocks: readonly WeworkConversationBlock[]): string {
  const toolCount = blocks.filter(block => block.type === 'tool').length
  const changedFileCount = blocks.reduce(
    (total, block) =>
      block.type === 'file_changes' ? total + fileChangesCount(block.fileChanges) : total,
    0
  )
  const thinkingCount = blocks.filter(block => block.type === 'thinking').length
  const summary = processingSummary(toolCount, changedFileCount, thinkingCount)
  const content = blocks.map(formatBlockMarkdown).filter(Boolean).join('\n\n')
  return `<details>\n<summary>${summary}</summary>\n\n${content}\n\n</details>`
}

function formatBlockMarkdown(block: WeworkConversationBlock): string {
  if (block.type === 'tool') {
    return [
      `### Tool: ${block.toolName}`,
      block.toolInput === undefined
        ? ''
        : `**Input**\n\n\`\`\`json\n${prettyValue(block.toolInput)}\n\`\`\``,
      block.toolOutput === undefined
        ? ''
        : `**Output**\n\n\`\`\`\n${prettyValue(block.toolOutput)}\n\`\`\``,
    ]
      .filter(Boolean)
      .join('\n\n')
  }
  if (block.type === 'file_changes') {
    return `### File changes\n\n\`\`\`json\n${prettyValue(block.fileChanges)}\n\`\`\``
  }
  const label =
    block.type === 'plan' ? 'Plan' : block.type === 'thinking' ? 'Thought process' : 'Text'
  return `### ${label}\n\n${block.content}`
}

function formatConversationHtml(snapshot: WeworkConversationSnapshot, exportedAt: Date): string {
  const content = snapshot.turns.map(turn => itemsHtml(turn.items)).join('\n')
  const title = escapeHtml(snapshot.title)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root{color-scheme:light dark;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:#f5f5f4;color:#1c1917}
main{width:min(880px,calc(100% - 32px));margin:40px auto 80px}
header{margin-bottom:28px}h1{margin:0 0 8px;font-size:28px}header p{margin:0;color:#78716c}
.entry{margin:14px 0;padding:18px 20px;border:1px solid #e7e5e4;border-radius:14px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.entry.user{background:#fafaf9}.label{margin-bottom:10px;font-size:13px;font-weight:650;color:#57534e}
.content{overflow-wrap:anywhere;font:inherit;line-height:1.65}.content>:first-child{margin-top:0}.content>:last-child{margin-bottom:0}.content p,.content ul,.content ol,.content blockquote,.content pre,.content table{margin:10px 0}.content h1,.content h2,.content h3,.content h4{margin:18px 0 8px}.content h1{font-size:22px}.content h2{font-size:18px}.content h3,.content h4{font-size:15px}.content ul,.content ol{padding-left:24px}.content blockquote{padding-left:12px;border-left:3px solid #d6d3d1;color:#57534e}.content code{padding:2px 5px;border-radius:4px;background:#f5f5f4;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.content pre{padding:12px;overflow:auto;border-radius:8px;background:#1c1917;color:#f5f5f4}.content pre code{padding:0;background:transparent;color:inherit}.content table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.content th,.content td{padding:6px 9px;border:1px solid #d6d3d1}.content a{color:#2563eb}.content img{display:block;max-width:100%;max-height:680px;margin:10px 0;border-radius:10px;object-fit:contain}
.block{border-left:3px solid #a8a29e}.block h2{margin:0 0 10px;font-size:14px}
.process-group{margin:8px 0;color:#78716c}.process-group>summary{display:flex;min-height:32px;align-items:center;gap:6px;padding:4px 2px;cursor:pointer;font-size:12px;list-style:none}.process-group>summary::-webkit-details-marker{display:none}.process-group>summary::before{content:"›";font-size:18px;line-height:1;color:#a8a29e;transition:transform .15s ease}.process-group[open]>summary::before{transform:rotate(90deg)}.process-list{margin-left:8px;padding-left:14px;border-left:1px solid #e7e5e4}.process-item{border-bottom:1px solid #e7e5e4}.process-item:last-child{border-bottom:0}.process-item>summary{padding:8px 0;cursor:pointer;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#57534e}.process-item[open]>summary{margin-bottom:6px}.process-item .label{margin:7px 0 4px}.process-item pre.data{margin:0 0 8px}
pre.data{padding:12px;overflow:auto;border-radius:8px;background:#1c1917;color:#f5f5f4;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
.attachments{display:grid;gap:10px;margin-top:12px;color:#57534e}.attachments figure{margin:0}.attachments img{display:block;max-width:100%;max-height:680px;border-radius:10px;object-fit:contain}.attachments figcaption{margin-top:5px;font-size:12px;color:#78716c}.attachments span{color:#a8a29e}
@media(prefers-color-scheme:dark){body{background:#0c0a09;color:#f5f5f4}.entry{border-color:#292524;background:#1c1917}.entry.user{background:#171412}.label,header p,.attachments{color:#a8a29e}.content blockquote{border-color:#57534e;color:#a8a29e}.content code{background:#292524}.content th,.content td{border-color:#44403c}.content a{color:#60a5fa}.process-list{border-color:#292524}.process-item{border-color:#292524}.process-item>summary{color:#d6d3d1}pre.data{background:#0c0a09}}
</style>
</head>
<body>
<main>
<header><h1>${title}</h1><p>Exported from Wework on ${escapeHtml(exportedAt.toISOString())}${
    snapshot.complete ? '' : ' while the conversation was active'
  }</p></header>
${content}
</main>
</body>
</html>
`
}

function itemsHtml(items: readonly WeworkConversationItem[]): string {
  const sections: string[] = []
  let processingBlocks: WeworkConversationBlock[] = []
  const flushProcessing = () => {
    if (processingBlocks.length === 0) return
    const group = processingGroupHtml(processingBlocks)
    if (group) sections.push(group)
    processingBlocks = []
  }

  for (const item of items) {
    if (item.type === 'block' && ['thinking', 'tool', 'file_changes'].includes(item.block.type)) {
      processingBlocks.push(item.block)
      continue
    }
    flushProcessing()
    sections.push(itemHtml(item))
  }
  flushProcessing()
  return sections.join('\n')
}

function itemHtml(item: WeworkConversationItem): string {
  if (item.type === 'user_message') {
    const attachments =
      item.attachments.length === 0
        ? ''
        : `<div class="attachments">${item.attachments.map(attachmentHtml).join('')}</div>`
    return messageHtml('User', item.content || 'Empty message', 'user', attachments)
  }
  if (item.type === 'assistant_text') {
    return messageHtml('Assistant', item.content, 'assistant')
  }
  return blockHtml(item.block)
}

function processingGroupHtml(blocks: readonly WeworkConversationBlock[]): string {
  const toolCount = blocks.filter(block => block.type === 'tool').length
  const changedFileCount = blocks.reduce(
    (total, block) =>
      block.type === 'file_changes' ? total + fileChangesCount(block.fileChanges) : total,
    0
  )
  const thinkingCount = blocks.filter(block => block.type === 'thinking').length

  return `<details class="process-group"><summary><span>${escapeHtml(
    processingSummary(toolCount, changedFileCount, thinkingCount)
  )}</span></summary><div class="process-list">${blocks
    .map(processingItemHtml)
    .join('')}</div></details>`
}

function processingItemHtml(block: WeworkConversationBlock): string {
  if (block.type === 'tool') {
    return `<details class="process-item tool-call"><summary>${escapeHtml(
      block.toolName
    )}</summary>${dataHtml('Input', block.toolInput)}${dataHtml(
      'Output',
      block.toolOutput
    )}</details>`
  }
  if (block.type === 'file_changes') {
    const count = fileChangesCount(block.fileChanges)
    return `<details class="process-item file-changes"><summary>${escapeHtml(
      count > 0 ? `${count} file${count === 1 ? '' : 's'} changed` : 'File changes'
    )}</summary>${dataHtml('', block.fileChanges)}</details>`
  }
  if (block.type === 'thinking') {
    return `<details class="process-item thinking"><summary>Thought process</summary><div class="content">${renderMarkdownHtml(
      block.content
    )}</div></details>`
  }
  return ''
}

function fileChangesCount(value: unknown): number {
  if (!value || typeof value !== 'object') return 0
  const files = (value as { files?: unknown }).files
  return Array.isArray(files) ? files.length : 0
}

function attachmentHtml(
  attachment: WeworkConversationAttachment & {
    readonly dataUrl?: string | null
    readonly exportPath?: string | null
  }
): string {
  if (attachment.dataUrl?.startsWith('data:image/')) {
    return `<figure><img alt="${escapeHtml(attachment.filename)}" src="${escapeHtml(
      attachment.dataUrl
    )}"><figcaption>${escapeHtml(attachment.filename)}</figcaption></figure>`
  }
  if (attachment.exportPath) {
    return `<div><a href="${escapeHtml(attachment.exportPath)}">${escapeHtml(
      attachment.filename
    )}</a> <span>${escapeHtml(attachment.mimeType)}</span></div>`
  }
  return `<div>${escapeHtml(attachment.filename)} <span>${escapeHtml(
    attachment.mimeType
  )}</span></div>`
}

function messageHtml(label: string, content: string, kind: string, suffix = ''): string {
  const body = content.trim() ? `<div class="content">${renderMarkdownHtml(content)}</div>` : ''
  return `<section class="entry ${kind}"><div class="label">${label}</div>${body}${suffix}</section>`
}

function blockHtml(block: WeworkConversationBlock): string {
  if (block.type === 'thinking' || block.type === 'tool' || block.type === 'file_changes') {
    return processingGroupHtml([block])
  }
  const label = block.type === 'plan' ? 'Plan' : 'Text'
  return `<section class="entry block ${block.type}"><h2>${label}</h2><div class="content">${renderMarkdownHtml(
    block.content
  )}</div></section>`
}

function attachmentMarkdown(
  attachment: WeworkConversationAttachment & { readonly exportPath?: string | null }
): string {
  if (!attachment.exportPath) return `- ${attachment.filename} (${attachment.mimeType})`
  const target = `<${attachment.exportPath}>`
  return attachment.mimeType.toLowerCase().startsWith('image/')
    ? `![${attachment.filename}](${target})`
    : `- [${attachment.filename}](${target})`
}

function processingSummary(
  toolCount: number,
  changedFileCount: number,
  thinkingCount: number
): string {
  return [
    toolCount > 0 ? `Called ${toolCount} tool${toolCount === 1 ? '' : 's'}` : '',
    changedFileCount > 0
      ? `edited ${changedFileCount} file${changedFileCount === 1 ? '' : 's'}`
      : '',
    thinkingCount > 0 ? `${thinkingCount} thought process${thinkingCount === 1 ? '' : 'es'}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

function dataHtml(label: string, value: unknown): string {
  if (value === undefined) return ''
  const heading = label ? `<div class="label">${label}</div>` : ''
  return `${heading}<pre class="data">${escapeHtml(prettyValue(value))}</pre>`
}

function prettyValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    character =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ??
      character
  )
}
