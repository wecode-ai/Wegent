import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'

// A real PNG travels through upload, snapshot and native model input. Only recognition is scripted.
export const IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAIAAAACUFjqAAAAEklEQVR4nGP4z8CAB+GTG8HSALfKY52fTcuYAAAAAElFTkSuQmCC',
  'base64'
)
export const IMAGE_HASH = createHash('sha256').update(IMAGE_BYTES).digest('hex')
export const IMAGE_NAME = 'memory-image-evidence.png'
export const IMAGE_OBSERVATION = '测试图片呈红色，可能表示测试项目发布阻塞。'
export const IMAGE_MEMORY = `MEMORY_IMAGE：AI 图片解读（待核实）：${IMAGE_OBSERVATION}`

export function imageRecallRole(settings, id) {
  // The primary identity may omit collaboration; independent roles may not.
  const template = settings.roles.find(role => role.id === 'default')
  assert.ok(template, 'Use the validated default role as the independent-role template')
  return { ...template, id, name: '图片记忆验收', enabled: false, prompt: '', version: 0 }
}

export function createImageReview(source) {
  let saved
  let committed
  function* steps() {
    let page = yield ['next_memory_page', { taskId: source }]
    while (!page.historyReadComplete) page = yield ['next_memory_page', { taskId: source }]
    assert.equal(page.readyToComplete, false)
    const list = yield ['list_memory_attachments', { taskId: source }]
    assert.equal(list.nextOffset, null)
    assert.ok(list.items.every(row => !('path' in row)))
    const attachment = list.items.find(row => row.filename === IMAGE_NAME)
    assert.ok(attachment)
    const args = { taskId: source, attachmentId: attachment.attachmentId }
    const read = yield ['read_memory_attachment', args]
    assert.equal(read.content, IMAGE_OBSERVATION)
    assert.equal(read.evidenceKind, 'image_observation')
    assert.equal(read.contentHash, IMAGE_HASH)
    assert.equal(read.contentComplete, true)
    assert.ok(!('dataUrl' in read) && !('path' in read))
    assert.deepEqual(yield ['read_memory_attachment', args], read)
    saved = yield [
      'remember_from_attachment',
      {
        ...args,
        contentHash: IMAGE_HASH,
        excerpt: IMAGE_OBSERVATION,
        content: IMAGE_MEMORY,
      },
    ]
    assert.equal(saved.content, IMAGE_MEMORY)
    assert.equal(saved.evidence.kind, 'image_observation')
    assert.equal(saved.evidence.contentHash, IMAGE_HASH)
    assert.equal(saved.evidence.attachmentId, attachment.attachmentId)
    assert.equal(saved.evidence.excerpt, IMAGE_OBSERVATION)
    page = yield ['next_memory_page', { taskId: source }]
    assert.equal(page.readyToComplete, true)
    committed = yield ['complete_memory_source', { taskId: source }]
    assert.ok(committed.completedThrough > 0)
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
    get saved() {
      return saved
    },
    get committed() {
      return committed
    },
    advance(body) {
      if (call && !requestContainsToolOutput(body, call.id)) return emit(body)
      const result = call ? JSON.parse(readMcpToolOutput(body, call.id)) : undefined
      if (result) assert.ok(!result.error && !result.isError, JSON.stringify(result))
      const next = iterator.next(result)
      if (next.done) return undefined
      call = { name: next.value[0], args: next.value[1], id: `image-evidence-${++sequence}` }
      return emit(body)
    },
  }
}
