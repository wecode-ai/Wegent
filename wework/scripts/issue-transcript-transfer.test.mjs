import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'

import { findTranscriptItemPage } from '../e2e/desktop/modules/issue-transcript-transfer.mjs'

const ITEM_ID = 'issue-large-history-tool'
const QUERY = { deviceId: 'device-1', taskId: 'task-1', limit: 5 }

test('large tool checks use its older page and preserve its complete chunked body', async () => {
  const output = Array.from({ length: 56_000 }, (_, index) =>
    createHash('sha256').update(String(index)).digest('hex')
  ).join('\n')
  const cursor = 'opaque-native-item-cursor'
  const tool = {
    id: ITEM_ID,
    type: 'block',
    block: { id: ITEM_ID, type: 'tool', tool_name: 'bash', tool_output: output },
  }
  const pages = new Map([
    [
      undefined,
      {
        turns: [{ id: 'turn-1', items: [{ id: 'assistant', type: 'agentMessage', text: 'Done' }] }],
        hasMoreBefore: true,
        beforeCursor: cursor,
      },
    ],
    [cursor, { turns: [{ id: 'turn-1', items: [tool] }], hasMoreBefore: false }],
  ])
  const packed = new Map(
    [...pages].map(([cursor, transcript]) => [
      cursor,
      gzipSync(JSON.stringify({ transcript, strings: [], references: [] })),
    ])
  )
  const queries = []
  const result = await findTranscriptItemPage(
    QUERY,
    async query => {
      queries.push(query)
      assert.equal(query.transcriptProtocolVersion, 2)
      const bytes = packed.get(query.beforeCursor)
      assert.ok(bytes, 'Only the returned native cursor may select the older page')
      const snapshotId = createHash('sha256').update(bytes).digest('hex')
      const offset = query.transcriptTransfer?.offset ?? 0
      if (offset) assert.equal(query.transcriptTransfer.snapshotId, snapshotId)
      const end = Math.min(offset + 360 * 1024, bytes.length)
      return {
        transcriptProtocolVersion: 2,
        transfer: {
          encoding: 'gzip+base64+json',
          snapshotId,
          totalBytes: bytes.length,
          offset,
          payload: bytes.subarray(offset, end).toString('base64'),
          nextOffset: end < bytes.length ? end : null,
        },
      }
    },
    ITEM_ID
  )

  assert.ok(packed.get(undefined).length < 980_000)
  assert.ok(result.totalBytes > 980_000)
  assert.equal(result.item.block.tool_output, output)
  assert.deepEqual(result.query, { ...QUERY, beforeCursor: cursor })
  assert.equal(queries.filter(query => query.beforeCursor === undefined).length, 1)
  const olderQueries = queries.filter(query => query.beforeCursor === cursor)
  assert.ok(olderQueries.length > 1, 'The oversized page must require chunk continuations')
  assert.equal(olderQueries[0].transcriptTransfer, undefined)
  assert.ok(olderQueries.slice(1).every(query => query.transcriptTransfer.offset > 0))
  assert.ok(queries.every(query => query.taskId === QUERY.taskId && query.limit === QUERY.limit))
})

test('pagination fails when history ends before the seeded tool', async () => {
  await assert.rejects(
    findTranscriptItemPage(
      QUERY,
      async () => ({ turns: [], hasMoreBefore: false, beforeCursor: null }),
      ITEM_ID
    ),
    /History ended before restoring the seeded item/
  )
})

test('pagination requires a cursor for an advertised older page', async () => {
  await assert.rejects(
    findTranscriptItemPage(QUERY, async () => ({ turns: [], hasMoreBefore: true }), ITEM_ID),
    /An older history page must have a continuation cursor/
  )
})

test('pagination fails on a repeated native cursor', async () => {
  const queries = []
  await assert.rejects(
    findTranscriptItemPage(
      QUERY,
      async query => {
        queries.push(query)
        return { turns: [], hasMoreBefore: true, beforeCursor: 'same-cursor' }
      },
      ITEM_ID
    ),
    /History returned a repeated continuation cursor/
  )
  assert.equal(queries.length, 2)
})

test('a failed page read propagates immediately without retrying', async () => {
  const failure = new Error('Native history read failed')
  let reads = 0
  await assert.rejects(
    findTranscriptItemPage(
      QUERY,
      async () => {
        reads += 1
        throw failure
      },
      ITEM_ID
    ),
    error => error === failure
  )
  assert.equal(reads, 1)
})
