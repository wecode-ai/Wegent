import assert from 'node:assert/strict'

/** Reuse the CI-covered real MCP transport, domain services and database. */
export async function verifyCollaborationBatchTools({ request, project }) {
  let requestId = 0
  async function call(name, args) {
    const response = await request('/mcp/wework-space/sse', {
      method: 'POST',
      headers: { Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `batch-${++requestId}`,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    })
    assert.ok(!response.error, JSON.stringify(response.error))
    assert.ok(!response.result.isError, JSON.stringify(response.result))
    const result = JSON.parse(response.result.content.find(block => block.type === 'text').text)
    assert.ok(!result.error, JSON.stringify(result.error))
    return result
  }

  const space = { project_store: 'backend', space_id: String(project.id) }
  const marker = `Batch contract ${process.pid}`
  const creation = {
    operation_key: `batch-create-${process.pid}`,
    items: ['first', 'second'].map(request_id => ({
      request_id,
      space,
      item: { title: `${marker} ${request_id}` },
    })),
  }
  const created = await call('batch_create_board_items', creation)
  assert.equal(created.counts.succeeded, 2)
  assert.deepEqual(await call('batch_create_board_items', creation), created)
  const query = await call('search_board_items', {
    scope: { kind: 'projects', spaces: [space] },
    query: marker,
    limit: 1,
  })
  assert.equal(query.coverage.complete, true)
  assert.equal(query.matched_total, 2)
  assert.equal(query.items.length, 1)
  const next = await call('search_board_items', { cursor: query.next_cursor, limit: 1 })
  assert.equal(next.items.length, 1)
  assert.notEqual(next.items[0].id, query.items[0].id)
  const aggregation = await call('aggregate_board_items', {
    query_id: query.query_id,
    group_by: ['space'],
  })
  assert.equal(aggregation.buckets[0].count, 2)

  const updates = {
    operation_key: `batch-update-${process.pid}`,
    items: created.results.map(result => ({
      request_id: result.request_id,
      target: result.target,
      expected_version: result.item_version,
      patch: { title: `${marker} reviewed ${result.request_id}` },
    })),
  }
  const preview = await call('batch_update_board_items', { ...updates, preview: true })
  assert.ok(preview.results.every(result => result.committed === false))
  const changed = await call('batch_update_board_items', updates)
  assert.equal(changed.counts.succeeded, 2)
  assert.deepEqual(await call('batch_update_board_items', updates), changed)
  const stale = await call('batch_update_board_items', {
    ...updates,
    operation_key: `${updates.operation_key}-stale`,
  })
  assert.equal(stale.counts.failed, 2)
  assert.ok(stale.results.every(result => result.error.code === 'version_conflict'))
  assert.deepEqual(
    await call('get_board_operation', { operation_key: updates.operation_key }),
    changed
  )

  const comments = {
    operation_key: `batch-comments-${process.pid}`,
    items: [0, 1, 2].map(index => ({
      request_id: String(index),
      target: created.results[0].target,
      body: `Batch history evidence ${index}`,
    })),
  }
  const written = await call('batch_add_board_item_comments', comments)
  assert.equal(written.counts.succeeded, 3)
  assert.deepEqual(await call('batch_add_board_item_comments', comments), written)
  const read = await call('batch_list_board_item_comments', {
    items: [{ request_id: 'history', target: created.results[0].target, mode: 'oldest', limit: 2 }],
  })
  const history = read.results[0].result
  assert.equal(history.history_complete, false)
  assert.equal(history.comments[0].body, 'Batch history evidence 0')
  const remainder = await call('batch_list_board_item_comments', {
    items: [
      {
        request_id: 'remainder',
        target: created.results[0].target,
        mode: 'after',
        cursor: history.next_cursor,
        limit: 2,
      },
    ],
  })
  assert.equal(remainder.results[0].result.comments.at(-1).body, 'Batch history evidence 2')
  assert.equal(remainder.results[0].result.history_complete, true)
  const latest = await call('batch_list_board_item_comments', {
    items: [{ request_id: 'latest', target: created.results[0].target, mode: 'latest', limit: 1 }],
  })
  assert.equal(latest.results[0].result.comments[0].body, 'Batch history evidence 2')
  assert.equal(latest.results[0].result.history_complete, false)
  const afterLatest = await call('batch_list_board_item_comments', {
    items: [
      {
        request_id: 'after-latest',
        target: created.results[0].target,
        mode: 'after',
        cursor: latest.results[0].result.next_cursor,
        limit: 1,
      },
    ],
  })
  assert.deepEqual(afterLatest.results[0].result.comments, [])
  assert.equal(afterLatest.results[0].result.history_complete, false)
}
