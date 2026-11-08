import assert from 'node:assert/strict'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'
import { DOCUMENT_FACT, DOCUMENT_TEXT } from './stand-in-memory-document.mjs'

export const PROJECT_FILE_MEMORY = `MEMORY_PROJECT_FILE：${DOCUMENT_FACT}`
export const PROJECT_ATTACHMENT_MEMORY = `MEMORY_PROJECT_ATTACHMENT：${DOCUMENT_FACT}`
export const PROJECT_STANDALONE_MEMORY = `MEMORY_PROJECT_STANDALONE：${DOCUMENT_FACT}`

export function createProjectFileReview(source, expectedHash, attachmentId, fileId) {
  let call
  let sequence = 0
  let saved
  let attachmentSaved
  let standaloneSaved
  let standalonePhase = false
  let attachmentPhase = false
  let checkingCompletedFile = false
  const attachmentSource = {
    projectId: source.projectId,
    projectStore: source.projectStore,
    itemId: source.itemId,
    attachmentId,
  }
  const fileSource = { projectId: source.projectId, projectStore: source.projectStore, fileId }
  const currentSource = () =>
    standalonePhase ? fileSource : attachmentPhase ? attachmentSource : source
  const currentKind = () =>
    standalonePhase ? 'file' : attachmentPhase ? 'attachment' : 'delivery_asset'
  const currentMemory = () =>
    standalonePhase
      ? PROJECT_STANDALONE_MEMORY
      : attachmentPhase
        ? PROJECT_ATTACHMENT_MEMORY
        : PROJECT_FILE_MEMORY
  let inventory = ''
  let delivery = ''
  let document = ''
  let chunks = 0
  const emit = body =>
    mcpToolRequestEvents(body, {
      toolName: call.name,
      directToolName: `mcp__wework_stand_in__${call.name}`,
      argumentsValue: call.args,
      searchCallId: `${call.id}-search`,
      toolCallId: call.id,
    }).events
  const next = (body, name, args) => {
    call = { name, args, id: `project-file-${++sequence}` }
    return emit(body)
  }
  return {
    get saved() {
      return saved
    },
    get attachmentSaved() {
      return attachmentSaved
    },
    get standaloneSaved() {
      return standaloneSaved
    },
    advance(body) {
      if (!call) return next(body, 'list_memory_projects', {})
      if (!requestContainsToolOutput(body, call.id)) return emit(body)
      const result = JSON.parse(readMcpToolOutput(body, call.id))
      assert.ok(!result.error && !result.isError, JSON.stringify(result))
      switch (call.name) {
        case 'list_memory_projects':
          inventory += result.content
          if (result.nextOffset != null)
            return next(body, call.name, {
              offset: result.nextOffset,
              contentHash: result.contentHash,
            })
          assert.equal(JSON.parse(inventory).coverage.local, 'listed')
          assert.ok(
            JSON.parse(inventory).items.some(
              row => row.id === source.projectId && row.store === 'local'
            )
          )
          return next(body, 'read_memory_project', { ...source, kind: 'delivery' })
        case 'read_memory_project':
          if (checkingCompletedFile) {
            assert.equal(result.unchanged, true)
            assert.equal(result.reviewCompleted, true)
            assert.equal(result.contentHash, call.args.contentHash)
            assert.equal(result.content, undefined, 'Completed unchanged files omit their body')
            checkingCompletedFile = false
            if (standalonePhase) return undefined
            delivery = ''
            document = ''
            chunks = 0
            if (attachmentPhase) {
              standalonePhase = true
              return next(body, 'read_memory_project', { ...fileSource, kind: 'files' })
            }
            attachmentPhase = true
            return next(body, 'read_memory_project', { ...attachmentSource, kind: 'attachments' })
          }
          assert.ok(Buffer.byteLength(result.content) <= 8192)
          if (['attachments', 'files'].includes(call.args.kind)) {
            delivery += result.content
            if (result.nextOffset != null)
              return next(body, call.name, {
                ...call.args,
                offset: result.nextOffset,
                contentHash: result.contentHash,
              })
            assert.ok(
              JSON.parse(delivery).some(row => row.id === (standalonePhase ? fileId : attachmentId))
            )
            return next(body, call.name, { ...currentSource(), kind: currentKind() })
          }
          if (call.args.kind === 'delivery') {
            delivery += result.content
            if (result.nextOffset != null)
              return next(body, call.name, {
                ...call.args,
                offset: result.nextOffset,
                contentHash: result.contentHash,
              })
            const detail = JSON.parse(delivery)
            assert.ok((detail.delivery ?? detail).assets.some(asset => asset.id === source.assetId))
            return next(body, call.name, { ...source, kind: 'delivery_asset' })
          }
          document += result.content
          chunks++
          if (result.nextOffset != null)
            return next(body, call.name, {
              ...call.args,
              offset: result.nextOffset,
              contentHash: result.contentHash,
            })
          assert.ok(chunks > 1)
          assert.deepEqual(JSON.parse(document), {
            ...(standalonePhase
              ? { fileId }
              : attachmentPhase
                ? { attachmentId }
                : { assetId: source.assetId }),
            content: DOCUMENT_TEXT,
            originalContentHash: expectedHash,
          })
          assert.ok(result.content.includes(DOCUMENT_FACT))
          return next(body, 'remember_from_project', {
            ...call.args,
            contentHash: result.contentHash,
            excerpt: DOCUMENT_FACT,
            content: currentMemory(),
          })
        case 'remember_from_project':
          assert.equal(result.content, currentMemory())
          assert.deepEqual(result.scope, { kind: 'project', id: source.projectId, store: 'local' })
          assert.deepEqual(
            result.evidence.source,
            standalonePhase
              ? { ...fileSource, kind: 'file', itemId: null, deliveryId: null }
              : attachmentPhase
                ? { ...attachmentSource, kind: 'attachment', deliveryId: null }
                : { ...source, kind: 'delivery_asset' }
          )
          assert.equal(result.evidence.excerpt, DOCUMENT_FACT)
          if (standalonePhase) standaloneSaved = result
          else if (attachmentPhase) attachmentSaved = result
          else saved = result
          return next(body, 'complete_memory_project', {
            ...currentSource(),
            kind: currentKind(),
            contentHash: call.args.contentHash,
          })
        case 'complete_memory_project':
          assert.equal(result.completed, true)
          assert.equal(result.contentHash, call.args.contentHash)
          checkingCompletedFile = true
          return next(body, 'read_memory_project', { ...call.args, offset: 0 })
        default:
          throw new Error(`Unexpected project file tool ${call.name}`)
      }
    },
  }
}
