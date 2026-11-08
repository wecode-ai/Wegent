import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'

export const VISUAL_PDF_NAME = 'memory-visual-only.pdf'

export function memoryVisualPdfFixture() {
  const content = 'q 100 0 0 100 0 0 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID abc EI Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = []
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

export function createUnreadableDocumentReview(source) {
  let completed = false
  function* steps() {
    let cursor
    let found = false
    do {
      const listing = JSON.parse(yield ['list_memory_sources', cursor ? { cursor } : {}])
      found ||= listing.items.some(item => item.taskId === source)
      cursor = listing.nextCursor
    } while (cursor)
    assert.ok(found, 'The incomplete source remains discoverable on every review')
    let page
    do {
      page = JSON.parse(yield ['next_memory_page', { taskId: source }])
    } while (!page.historyReadComplete)
    assert.equal(page.readyToComplete, false)
    assert.ok(page.unreadAttachmentCount > 0)
    const listing = JSON.parse(yield ['list_memory_attachments', { taskId: source }])
    const attachment = listing.items.find(item => item.filename === VISUAL_PDF_NAME)
    assert.ok(attachment)
    const failure = yield [
      'read_memory_attachment',
      { taskId: source, attachmentId: attachment.attachmentId },
    ]
    assert.match(failure, /no extractable text/)
    assert.match(failure, /visual content has not been read/)
    const rejected = yield ['complete_memory_source', { taskId: source }]
    assert.match(rejected, /Attachment has not been read/)
    page = JSON.parse(yield ['next_memory_page', { taskId: source }])
    assert.equal(page.readyToComplete, false)
    assert.ok(page.unreadAttachmentCount > 0)
    completed = true
  }
  const iterator = steps()
  let call
  let sequence = 0
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  return {
    get completed() {
      return completed
    },
    advance(body) {
      if (call && !requestContainsToolOutput(body, call.id)) return emit(body)
      const next = iterator.next(call ? readMcpToolOutput(body, call.id) : undefined)
      if (next.done) return undefined
      call = { name: next.value[0], args: next.value[1], id: `unreadable-document-${++sequence}` }
      return emit(body)
    },
  }
}
