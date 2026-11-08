import assert from 'node:assert/strict'
import { IMAGE_HASH, IMAGE_OBSERVATION } from './stand-in-memory-image.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { mcpToolRequestEvents, requestContainsToolOutput } from './response-protocol.mjs'

export const projectImageMemory = kind =>
  `MEMORY_PROJECT_IMAGE:${kind}：待核实：${IMAGE_OBSERVATION}`

export function createProjectImageReview(sources, unchanged = false) {
  const saved = []
  let completed = false
  function* steps() {
    for (const source of sources) {
      const page = yield ['read_memory_project', source]
      if (unchanged) {
        assert.equal(page.unchanged, true)
        assert.equal(page.reviewCompleted, true)
        assert.ok(!('content' in page), 'Completed file bodies are omitted across runs')
        continue
      }
      assert.equal(page.nextOffset, null)
      assert.equal(page.evidenceKind, 'image_observation')
      const evidence = JSON.parse(page.content)
      assert.equal(evidence.content, IMAGE_OBSERVATION)
      assert.equal(evidence.originalContentHash, IMAGE_HASH)
      assert.equal(evidence.evidenceKind, 'image_observation')
      assert.ok(!JSON.stringify(page).includes('data:image'))
      assert.ok(!('imageInput' in evidence) && !('path' in evidence))
      assert.deepEqual(yield ['read_memory_project', source], page)
      const memory = yield [
        'remember_from_project',
        {
          ...source,
          contentHash: page.contentHash,
          excerpt: IMAGE_OBSERVATION,
          content: projectImageMemory(source.kind),
        },
      ]
      assert.equal(memory.content, projectImageMemory(source.kind))
      assert.equal(memory.evidence.kind, 'image_observation')
      assert.equal(memory.evidence.source.kind, source.kind)
      assert.equal(memory.evidence.source.projectId, source.projectId)
      for (const key of ['itemId', 'deliveryId', 'assetId', 'attachmentId', 'fileId']) {
        if (source[key]) assert.equal(memory.evidence.source[key], source[key])
      }
      saved.push(memory)
      const done = yield ['complete_memory_project', { ...source, contentHash: page.contentHash }]
      assert.equal(done.completed, true)
    }
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
    saved,
    get completed() {
      return completed
    },
    advance(body) {
      if (call && !requestContainsToolOutput(body, call.id)) return emit(body)
      const result = call ? JSON.parse(readMcpToolOutput(body, call.id)) : undefined
      if (result) assert.ok(!result.error && !result.isError, JSON.stringify(result))
      const next = iterator.next(result)
      if (next.done) return undefined
      call = { name: next.value[0], args: next.value[1], id: `project-image-${++sequence}` }
      return emit(body)
    },
  }
}
