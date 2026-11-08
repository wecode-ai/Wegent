import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'

export const DOCUMENT_NAME = 'memory-native-upload.docx'
export const DOCUMENT_FACT =
  '青榆测试项目周报先写验收结论，再列证据，最后列风险；验收代号为 QY-4729。'
export const DOCUMENT_MEMORY = `MEMORY_DOCUMENT：${DOCUMENT_FACT}`
export const DOCUMENT_TEXT = `${'背景资料🌳。'.repeat(800)}${DOCUMENT_FACT}`

export async function memoryDocumentFixture() {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${DOCUMENT_TEXT}</w:t></w:r></w:p></w:body></w:document>`
  )
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  return { bytes, hash: createHash('sha256').update(bytes).digest('hex') }
}

/** Script only model decisions; every asserted result comes from native MCP. */
export function createDocumentReview(source, expectedHash) {
  let call
  let sequence = 0
  let foundSource = false
  let attachment
  let offset = 0
  let actual = ''
  let chunks = 0
  let saved
  let committed
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  const next = (body, name, args) => {
    call = { name, args, id: `memory-document-${++sequence}` }
    return emit(body)
  }
  return {
    get saved() {
      return saved
    },
    get committed() {
      return committed
    },
    advance(body) {
      if (!call) return next(body, 'list_memory_sources', {})
      if (!requestContainsToolOutput(body, call.id)) return emit(body)
      const result = JSON.parse(readMcpToolOutput(body, call.id))
      assert.ok(!result.error && !result.isError, JSON.stringify(result))
      switch (call.name) {
        case 'list_memory_sources':
          foundSource ||= result.items.some(row => row.taskId === source)
          if (result.nextCursor) return next(body, call.name, { cursor: result.nextCursor })
          assert.ok(foundSource, 'The actual uploaded conversation must be discoverable')
          return next(body, 'next_memory_page', { taskId: source })
        case 'next_memory_page':
          if (!result.historyReadComplete) return next(body, call.name, { taskId: source })
          if (saved) {
            assert.equal(result.readyToComplete, true)
            return next(body, 'complete_memory_source', { taskId: source })
          }
          assert.equal(result.readyToComplete, false)
          assert.ok(result.unreadAttachmentCount > 0)
          return next(body, 'list_memory_attachments', { taskId: source })
        case 'list_memory_attachments':
          attachment = result.items.find(row => row.filename === DOCUMENT_NAME) ?? attachment
          assert.ok(
            result.items.every(row => !('path' in row)),
            'Do not expose host paths'
          )
          if (result.nextOffset != null)
            return next(body, call.name, { taskId: source, offset: result.nextOffset })
          assert.ok(attachment, 'Native userMessagePresentations must supply the upload binding')
          return next(body, 'read_memory_attachment', {
            taskId: source,
            attachmentId: attachment.attachmentId,
          })
        case 'read_memory_attachment':
          assert.equal(result.contentHash, expectedHash)
          assert.equal(result.offset, offset)
          assert.equal(result.totalContentBytes, Buffer.byteLength(DOCUMENT_TEXT))
          assert.ok(Buffer.byteLength(result.content) <= 8192)
          actual += result.content
          chunks++
          if (result.nextOffset != null) {
            assert.equal(result.contentComplete, false)
            offset = result.nextOffset
            return next(body, call.name, {
              taskId: source,
              attachmentId: attachment.attachmentId,
              offset,
              contentHash: expectedHash,
            })
          }
          assert.equal(result.contentComplete, true)
          assert.ok(chunks > 1, 'The native review must traverse more than one chunk')
          assert.equal(actual, DOCUMENT_TEXT)
          assert.ok(result.content.includes(DOCUMENT_FACT))
          return next(body, 'search_review_memories', { query: 'MEMORY_DOCUMENT' })
        case 'search_review_memories':
          assert.deepEqual(result.items, [], 'Uploading alone must not seed the expected memory')
          return next(body, 'remember_from_attachment', {
            taskId: source,
            attachmentId: attachment.attachmentId,
            offset,
            contentHash: expectedHash,
            excerpt: DOCUMENT_FACT,
            content: DOCUMENT_MEMORY,
          })
        case 'remember_from_attachment':
          assert.equal(result.content, DOCUMENT_MEMORY)
          assert.equal(result.evidence.role, 'attachment')
          assert.equal(result.evidence.taskId, source)
          assert.equal(result.evidence.contentHash, expectedHash)
          assert.equal(result.evidence.filename, DOCUMENT_NAME)
          assert.equal(result.evidence.excerpt, DOCUMENT_FACT)
          saved = result
          return next(body, 'next_memory_page', { taskId: source })
        case 'complete_memory_source':
          assert.ok(saved)
          assert.ok(result.completedThrough > 0)
          committed = result
          return undefined
        default:
          throw new Error(`Unexpected document memory tool: ${call.name}`)
      }
    },
  }
}
