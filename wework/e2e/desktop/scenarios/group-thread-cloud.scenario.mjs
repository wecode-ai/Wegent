import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'
import { holdDatabaseLock } from '../modules/database-lock.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'
import { repoDir, runChecked } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import {
  GROUP_MANUAL_MARKER,
  GROUP_MANUAL_RESULT,
  verifyGroupManualExecution,
} from '../modules/group-thread-manual-execution.mjs'
import {
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  streamingTextEvents,
} from '../modules/response-protocol.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`

/** Real Rust/Python, MinIO, persisted storage and two authenticated people. */
export async function createDesktopScenario({
  resultDir,
  captureScreenshot,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const storage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  let cloud
  let member
  let memberToken
  let owner
  let groupId
  let threadId
  let messageSequence = 0
  let manualModelRequests = 0
  const sockets = new Set()
  const title = `云端群 Thread 验收-${process.pid}`
  const groupName = `云端独立群-${process.pid}`
  const wait = (control, id, extra = {}) =>
    control.command('waitFor', scoped(id), { timeoutMs: uiTimeoutMs, ...extra })
  const click = (control, id) => control.command('click', scoped(id))
  const capture = (control, name) => captureScreenshot(control, name, CONTENT)

  async function request(
    path,
    { token = cloud.authToken, method = 'GET', body, status = 200 } = {}
  ) {
    const multipart = body instanceof FormData
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body === undefined ? {} : { body: multipart ? body : JSON.stringify(body) }),
    })
    assert.equal(
      response.status,
      status,
      `${method} ${path}: HTTP ${response.status}, expected ${status}`
    )
    if (status === 204) return null
    return response.json()
  }

  async function connectSocket(token) {
    const { io } = createRequire(
      new URL('../../../../packages/chat-core/package.json', import.meta.url)
    )(process.env.WEWORK_E2E_SOCKET_IO_CLIENT || 'socket.io-client')
    const socket = io(`${cloud.backendUrl}/wework-runtime`, {
      path: '/socket.io',
      transports: ['websocket'],
      auth: { token },
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: uiTimeoutMs,
    })
    sockets.add(socket)
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('connect_error', reject)
        socket.connect()
      })
      return socket
    } catch (error) {
      socket.disconnect()
      sockets.delete(socket)
      throw error
    }
  }

  async function send(token, content, { denied = false, connection } = {}) {
    const socket = connection ?? (await connectSocket(token))
    try {
      const ack = await socket
        .timeout(uiTimeoutMs)
        .emitWithAck('wework:project_chat:message:send', {
          projectId: groupId,
          containerKind: 'chat_group',
          taskId: threadId,
          clientMessageId: `cloud-thread-${process.pid}-${++messageSequence}`,
          content,
        })
      if (!ack.ok && !denied) {
        const status = await cloud.queryDatabase('SHOW ENGINE INNODB STATUS')
        await writeFile(
          join(resultDir, 'group-message-innodb-status.json'),
          JSON.stringify(
            {
              messageSequence,
              content,
              status,
            },
            null,
            2
          )
        )
      }
      assert.equal(ack.ok, !denied, `Unexpected discussion authority: ${JSON.stringify(ack)}`)
      return ack.result
    } finally {
      if (!connection) {
        socket.disconnect()
        sockets.delete(socket)
      }
    }
  }

  const participation = body =>
    request(`/api/v1/loop-items/${threadId}/participation`, {
      token: memberToken,
      method: 'PUT',
      body,
    })
  async function inbox() {
    const result = await request('/api/v1/wework-notifications', { token: memberToken })
    return result.items.filter(
      item => item.payload.groupId === groupId && item.payload.itemId === threadId
    )
  }

  async function upload(group, content) {
    const body = new FormData()
    body.set('path', 'same-name.txt')
    body.set('file', new Blob([content], { type: 'text/plain' }), 'same-name.txt')
    return request(`/api/v1/cloud-projects/${group}/files`, { method: 'POST', body, status: 201 })
  }

  async function verifyMigrationAssetCopies(control) {
    const workspace = await request('/api/v1/workspaces', {
      method: 'POST',
      status: 201,
      body: { name: 'Migration source authority' },
    })
    const project = await request('/api/v1/cloud-projects', {
      method: 'POST',
      status: 201,
      body: { workspace_id: workspace.id, name: 'Legacy migration source', task_provider: 'local' },
    })
    await request(`/api/v1/cloud-projects/${project.id}/members`, {
      method: 'POST',
      status: 201,
      body: { user_id: member.id, role: 'Viewer' },
    })
    const thread = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
      method: 'POST',
      status: 201,
      body: { title: 'Legacy public Thread' },
    })
    await request(`/api/v1/loop-items/${thread.id}/comments`, {
      method: 'POST',
      status: 201,
      body: { body: 'Historical discussion remains readable' },
    })
    const oldMention = await request(
      `/api/v1/cloud-projects/${project.id}/loop-items/${thread.id}/activity-comments`,
      {
        method: 'POST',
        body: {
          body: 'Historical mention does not grant authority in another group',
          mentions: [{ type: 'user', id: String(owner.id), label: owner.user_name }],
        },
      }
    )
    const oldEvents = await request('/api/v1/stand-in-issue-events?after=0')
    const oldEvent = oldEvents.events.find(event => event.payload.commentId === oldMention.id)
    assert.ok(oldEvent, 'The real mention must persist its recipient-owned source event')
    const body = new FormData()
    body.append('file', new Blob(['Migration source attachment']), 'source.txt')
    const attachment = await request(`/api/v1/loop-items/${thread.id}/attachments`, {
      method: 'POST',
      body,
      status: 201,
    })
    const empty = new FormData()
    empty.append('file', new Blob([]), 'empty.txt')
    const emptyAttachment = await request(`/api/v1/loop-items/${thread.id}/attachments`, {
      method: 'POST',
      body: empty,
      status: 201,
    })
    const delivery = await request(`/api/v1/loop-items/${thread.id}/deliveries`, {
      method: 'POST',
      status: 201,
      body: {
        title: 'Immutable historical delivery',
        markdown: 'Preserve this historical snapshot',
      },
    })
    await request(`/api/v1/deliveries/${delivery.id}/finalize`, { method: 'POST', body: {} })
    const { group } = await request('/api/v1/chat-groups', {
      method: 'POST',
      body: { name: 'Explicit migration target' },
    })
    await request(`/api/v1/loop-items/${thread.id}`, { token: memberToken })
    await runChecked(
      'uv',
      [
        'run',
        'python',
        join(repoDir, 'wework/e2e/desktop/fixtures/thread-migration-assets.py'),
        String(project.id),
        String(group.id),
        String(owner.id),
      ],
      { cwd: join(repoDir, 'backend'), env: cloud.backendEnv }
    )
    const migrated = await request(`/api/v1/loop-items/${thread.id}`)
    assert.equal(String(migrated.cloud_project_id), String(group.id))
    const comments = await request(`/api/v1/loop-items/${thread.id}/comments`)
    assert.ok(comments.some(comment => comment.body === 'Historical discussion remains readable'))
    for (const [file, expected] of [
      [attachment, 'Migration source attachment'],
      [emptyAttachment, ''],
    ]) {
      const response = await fetch(
        `${cloud.backendUrl}/api/v1/loop-item-attachments/${file.id}/content`,
        {
          headers: { Authorization: `Bearer ${cloud.authToken}` },
        }
      )
      assert.equal(response.status, 200)
      assert.equal(await response.text(), expected)
      await request(`/api/v1/loop-item-attachments/${file.id}/content`, {
        token: memberToken,
        status: 404,
      })
    }
    const snapshot = await request(`/api/v1/deliveries/${delivery.id}`)
    assert.equal(snapshot.markdown, 'Preserve this historical snapshot')
    await request(`/api/v1/loop-items/${thread.id}`, { token: memberToken, status: 404 })
    await request(`/api/v1/deliveries/${delivery.id}`, { token: memberToken, status: 404 })
    const formerProjectQueue = await request(
      `/api/v1/cloud-projects/${project.id}/executions?include_terminal=true`,
      { token: memberToken }
    )
    assert.equal(formerProjectQueue.total, 0)
    assert.deepEqual(formerProjectQueue.items, [])
    const retainedEvents = await request('/api/v1/stand-in-issue-events?after=0')
    assert.deepEqual(
      retainedEvents.events.find(event => event.sequence === oldEvent.sequence),
      oldEvent,
      'Migration must preserve the original event identity and source boundary'
    )
    await request(
      `/api/v1/cloud-projects/${project.id}/loop-items/${thread.id}/activity-comments?message_id=${oldMention.id}`,
      { status: 404 }
    )
    await assert.rejects(
      requestExecutor(
        control,
        'runtime.stand_in.assignment',
        { ...oldEvent.payload, recipientUserId: owner.id },
        uiTimeoutMs
      ),
      /Issue mention access was revoked/,
      'The real executor must reject a delayed source event after migration'
    )
    return { project, group }
  }

  async function verifyLegacyScopeWriteSerialization({ project, group }) {
    const agent = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`, {
      method: 'POST',
      status: 201,
      body: { name: 'Source scope marker', runtime: 'codex' },
    })
    const snapshot = async thread => {
      const [messages, comments, task] = await Promise.all([
        cloud.queryDatabase(
          'SELECT id,project_id,content,status,metadata FROM project_chat_messages WHERE task_id=%s ORDER BY id',
          [thread.id]
        ),
        cloud.queryDatabase(
          "SELECT id,cloud_project_id,description,status FROM loop_items WHERE resource_type='comment' AND loop_item_id=%s ORDER BY id",
          [thread.id]
        ),
        cloud.queryDatabase('SELECT cloud_project_id,version FROM loop_items WHERE id=%s', [
          thread.id,
        ]),
      ])
      return { messages, comments, task: task[0] }
    }
    const outcomes = []
    for (const mode of ['socket', 'http', 'agent_start', 'agent_update']) {
      const thread = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        status: 201,
        body: { title: `Scope move ${mode}` },
      })
      const connection = mode !== 'http' ? await connectSocket(cloud.authToken) : null
      const emit = (event, body) => connection.timeout(uiTimeoutMs + 15000).emitWithAck(event, body)
      const start = phase =>
        emit('wework:project_chat:agent:start', {
          projectId: String(project.id),
          taskId: thread.id,
          agent_id: String(agent.id),
          runtime_device_id: 'scope-marker-fixture',
          runtime_task_id: `scope-marker-${thread.id}-${phase}`,
        })
      const send = phase =>
        mode === 'http'
          ? fetch(`${cloud.backendUrl}/api/v1/loop-items/${thread.id}/comments`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${cloud.authToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ body: `${phase} source write` }),
            }).then(async response => ({
              ok: response.ok,
              status: response.status,
              body: await response.text(),
            }))
          : emit('wework:project_chat:message:send', {
              projectId: String(project.id),
              containerKind: 'project',
              taskId: thread.id,
              clientMessageId: `legacy-scope-${mode}-${phase}-${process.pid}`,
              content: `${phase} source write`,
            })
      const positive = mode.startsWith('agent_') ? await start('before') : await send('Before')
      assert.equal(positive.ok, true, JSON.stringify(positive))
      const before = await snapshot(thread)
      const lock = await holdDatabaseLock(
        cloud,
        "UPDATE loop_items SET cloud_project_id=%s, version=version+1 WHERE id=%s AND resource_type='task'",
        [String(group.id), thread.id]
      )
      let released = false
      let pending
      try {
        pending =
          mode === 'agent_start'
            ? start('after')
            : mode === 'agent_update'
              ? emit('wework:project_chat:agent:failed', {
                  projectId: String(project.id),
                  taskId: thread.id,
                  message_id: positive.result.messageId,
                  error: 'Stale source write',
                })
              : send('Stale')
        void pending.catch(() => {})
        const waits = await lock.waitForHeldRowLock('loop_items')
        assert.ok(waits.some(row => String(row.blocking_data).includes(thread.id)))
        await lock.release({ commit: true })
        released = true
        outcomes.push({ mode, outcome: await pending, waits })
      } finally {
        if (!released) await lock.release()
        await pending?.catch(() => {})
        connection?.disconnect()
        if (connection) sockets.delete(connection)
      }
      const after = await snapshot(thread)
      assert.equal(String(after.task.cloud_project_id), String(group.id))
      assert.equal(Number(after.task.version), Number(before.task.version) + 1)
      outcomes.at(-1).sideEffectsUnchanged =
        JSON.stringify(after.messages) === JSON.stringify(before.messages) &&
        JSON.stringify(after.comments) === JSON.stringify(before.comments)
      await writeFile(
        join(resultDir, 'legacy-scope-write-serialization.json'),
        JSON.stringify(outcomes, null, 2)
      )
    }
    assert.ok(
      outcomes.every(result => !result.outcome.ok && result.sideEffectsUnchanged),
      JSON.stringify(outcomes)
    )
  }

  async function verifyMilestoneGroupAuthority() {
    const workspace = await request('/api/v1/workspaces', {
      method: 'POST',
      status: 201,
      body: { name: 'Thread milestone authority' },
    })
    const project = await request('/api/v1/cloud-projects', {
      method: 'POST',
      status: 201,
      body: { workspace_id: workspace.id, name: 'Classified milestone', task_provider: 'local' },
    })
    await request(`/api/v1/cloud-projects/${project.id}/members`, {
      method: 'POST',
      status: 201,
      body: { user_id: member.id, role: 'Developer' },
    })
    const path = `/api/v1/cloud-projects/${project.id}/milestones`
    const milestone = await request(path, { method: 'POST', body: { title: 'Scoped counts' } })
    const records = []
    for (const [token, status] of [
      [cloud.authToken, 'pending'],
      [memberToken, 'completed'],
    ]) {
      const { group } = await request('/api/v1/chat-groups', {
        token,
        method: 'POST',
        body: { name: `Private milestone group ${status}` },
      })
      const thread = await request(`/api/v1/cloud-projects/${group.id}/loop-items`, {
        token,
        method: 'POST',
        status: 201,
        body: {
          title: `Scoped milestone ${status}`,
          status,
          milestone_id: milestone.id,
          classification_project_id: String(project.id),
        },
      })
      records.push({ token, group, thread })
    }
    const counts = async token => (await request(path, { token }))[0]
    assert.equal((await counts(cloud.authToken)).open_issues, 1)
    assert.equal((await counts(cloud.authToken)).closed_issues, 0)
    assert.equal((await counts(memberToken)).open_issues, 0)
    assert.equal((await counts(memberToken)).closed_issues, 1)
    await request(`/api/v1/loop-items/${records[1].thread.id}`, { status: 404 })
    await request(`/api/v1/chat-groups/${records[1].group.id}/members`, {
      token: memberToken,
      method: 'POST',
      body: { user_id: owner.id, role: 'Viewer' },
    })
    assert.equal((await counts(cloud.authToken)).closed_issues, 1)
    await request(`/api/v1/loop-items/${records[1].thread.id}`, {
      token: memberToken,
      method: 'DELETE',
      status: 204,
    })
    assert.equal((await counts(cloud.authToken)).closed_issues, 1)
    assert.equal((await counts(cloud.authToken)).archived_issues, 1)
    const archivePath = `/api/v1/cloud-projects/${project.id}/archived-loop-items`
    assert.deepEqual(
      (await request(archivePath)).items.map(item => item.id),
      [records[1].thread.id]
    )
    await request(`/api/v1/chat-groups/${records[1].group.id}/members/${owner.id}`, {
      token: memberToken,
      method: 'DELETE',
    })
    assert.equal((await counts(cloud.authToken)).closed_issues, 0)
    assert.equal((await request(archivePath)).items.length, 0)
    assert.deepEqual(
      (await request(archivePath, { token: memberToken })).items.map(item => item.id),
      [records[1].thread.id]
    )
    await request(`${path}/${milestone.id}`, {
      method: 'DELETE',
      body: { version: milestone.version },
    })
    await request(`/api/v1/loop-items/${records[1].thread.id}/restore`, {
      token: memberToken,
      method: 'POST',
    })
    for (const { token, thread, group } of records) {
      const kept = await request(`/api/v1/loop-items/${thread.id}`, { token })
      assert.equal(kept.milestone_id, null)
      assert.equal(kept.cloud_project_id, group.id)
      assert.equal(
        (await request(`/api/v1/loop-items/${thread.id}/project-link`, { token })).project.id,
        String(project.id)
      )
    }
  }

  async function verifyConcurrentMemberAndMessageWrites() {
    const created = await Promise.all([
      request('/api/v1/chat-groups', { method: 'POST', body: { name: 'Concurrent group A' } }),
      request('/api/v1/chat-groups', {
        token: memberToken,
        method: 'POST',
        body: { name: 'Concurrent group B' },
      }),
    ])
    const groups = created
      .map(value => value.group)
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    // Fixture identities put the inserted account before the next group's owner.
    for (const [index, group] of groups.entries()) {
      const user = index === 0 ? owner : member
      await cloud.executeDatabase('UPDATE loop_items SET created_by_user_id=%s WHERE id=%s', [
        user.id,
        group.id,
      ])
      await cloud.executeDatabase(
        "UPDATE resource_members SET user_id=%s,entity_id=%s WHERE resource_type='CollaborationChatGroup' AND resource_id=%s",
        [user.id, String(user.id), group.id]
      )
    }
    const thread = await request(`/api/v1/cloud-projects/${groups[0].id}/loop-items`, {
      method: 'POST',
      body: { title: 'Concurrent discussion' },
      status: 201,
    })
    const lock = await holdDatabaseLock(cloud, 'SELECT id FROM users WHERE id=%s FOR UPDATE', [
      owner.id,
    ])
    const waitForTransaction = async (group, blockers) => {
      const deadline = Date.now() + uiTimeoutMs
      while (Date.now() < deadline) {
        const rows = await cloud.queryDatabase(
          "SELECT DISTINCT CAST(w.REQUESTING_ENGINE_TRANSACTION_ID AS CHAR) AS id,CAST(w.BLOCKING_ENGINE_TRANSACTION_ID AS CHAR) AS blocker FROM performance_schema.data_lock_waits w JOIN performance_schema.data_locks root ON root.ENGINE=w.ENGINE AND root.ENGINE_TRANSACTION_ID=w.REQUESTING_ENGINE_TRANSACTION_ID WHERE root.OBJECT_SCHEMA=DATABASE() AND root.OBJECT_NAME='loop_items' AND root.INDEX_NAME='PRIMARY' AND root.LOCK_STATUS='GRANTED' AND LEFT(root.LOCK_MODE,1)='X' AND root.LOCK_DATA IN (%s,%s)",
          [group, `'${group}'`]
        )
        const expected = rows.find(row => blockers.includes(row.blocker))
        if (expected) return expected
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      assert.fail(`Expected the actual write transaction holding group ${group} to wait`)
    }
    let management
    let discussion
    const original = [groupId, threadId]
    try {
      const holders = await cloud.queryDatabase(
        "SELECT DISTINCT CAST(ENGINE_TRANSACTION_ID AS CHAR) AS id FROM performance_schema.data_locks WHERE OBJECT_SCHEMA=DATABASE() AND OBJECT_NAME='users' AND INDEX_NAME='PRIMARY' AND LOCK_STATUS='GRANTED' AND LEFT(LOCK_MODE,1)='X' AND LOCK_DATA=%s",
        [String(owner.id)]
      )
      assert.equal(holders.length, 1)
      const holder = holders[0].id
      management = request(`/api/v1/chat-groups/${groups[1].id}/members`, {
        token: memberToken,
        method: 'POST',
        body: { user_id: owner.id, role: 'Developer' },
      })
      void management.catch(() => {})
      const memberWait = await waitForTransaction(groups[1].id, [holder])
      groupId = groups[0].id
      threadId = thread.id
      discussion = send(cloud.authToken, 'Concurrent member and message transaction')
      void discussion.catch(() => {})
      const messageWait = await waitForTransaction(groups[0].id, [holder, memberWait.id])
      assert.notEqual(memberWait.id, messageWait.id)
      await writeFile(
        join(resultDir, 'concurrency-lock-evidence.json'),
        JSON.stringify(
          {
            holder,
            memberWait,
            messageWait,
          },
          null,
          2
        )
      )
    } finally {
      await lock.release()
      groupId = original[0]
      threadId = original[1]
      await Promise.all([management, discussion])
    }
    const granted = await request(`/api/v1/chat-groups/${groups[1].id}`)
    assert.ok(
      granted.members.some(person => person.user_id === owner.id && person.role === 'Developer')
    )
    const saved = await cloud.queryDatabase(
      'SELECT content FROM project_chat_messages WHERE project_id=%s AND task_id=%s AND sender_id=%s AND content=%s',
      [groups[0].id, thread.id, String(owner.id), 'Concurrent member and message transaction']
    )
    assert.equal(saved.length, 1)
  }

  return {
    requiresCloudEnvironment: true,
    backendEnv: storage.backendEnv,
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      if (!JSON.stringify(body.input).includes(GROUP_MANUAL_MARKER)) return false
      manualModelRequests += 1
      const events = streamingTextEvents(
        `group-manual-${Date.now()}`,
        GROUP_MANUAL_RESULT,
        'final_answer'
      )
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.end(
        createSse([
          ...events.start,
          {
            type: 'response.output_text.delta',
            item_id: events.itemId,
            output_index: 0,
            content_index: 0,
            delta: GROUP_MANUAL_RESULT,
            offset: 0,
          },
          ...events.finish,
        ])
      )
      return true
    },
    async cleanup() {
      for (const socket of sockets) socket.disconnect()
      sockets.clear()
      await storage.stop()
    },
    requiresRemoteExecutor: false,
    setCloudEnvironment(environment) {
      cloud = environment
    },
    async prepareCloud(environment) {
      cloud = environment
      assert.equal(new URL(cloud.backendUrl).hostname, '127.0.0.1')
      await cloud.executeDatabase('SET GLOBAL innodb_print_all_deadlocks=ON')
      await request('/api/admin/setup-complete', { method: 'POST' })
      owner = await request('/api/users/me')
      const userName = `group-thread-member-${process.pid}`
      const password = `group-thread-fixture-${process.pid}`
      member = await request('/api/admin/users', {
        method: 'POST',
        body: { user_name: userName, password, role: 'user', auth_source: 'password' },
        status: 201,
      })
      const login = await request('/api/auth/login', {
        method: 'POST',
        body: { user_name: userName, password },
      })
      memberToken = login.access_token
      assert.ok(memberToken)
    },
    async verify(control) {
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await wait(control, 'collaboration-view-groups')
      await click(control, 'collaboration-view-groups')
      await click(control, 'group-create-open')
      await control.command('fill', '[data-testid="create-group-name"]', { value: groupName })
      await control.command('select', '[data-testid="create-group-store"]', { value: 'cloud' })
      await control.command('click', '[data-testid="create-group-submit"]')
      await wait(control, 'group-room')
      await control.command('waitFor', `${CONTENT} header h1`, {
        text: groupName,
        timeoutMs: uiTimeoutMs,
      })
      groupId = new URL(
        JSON.parse(await control.command('snapshot', CONTENT)).location
      ).searchParams.get('groupId')
      assert.ok(groupId)
      await request(`/api/v1/chat-groups/${groupId}/members`, {
        method: 'POST',
        body: { user_id: member.id, role: 'Developer' },
      })
      await request(`/api/v1/chat-groups/${groupId}/members`, {
        method: 'POST',
        body: { user_id: owner.id, role: 'Viewer' },
        status: 409,
      })
      await request(`/api/v1/chat-groups/${groupId}/members`, {
        method: 'POST',
        body: { user_id: 2000000000, role: 'Developer' },
        status: 404,
      })
      const rejected = await cloud.queryDatabase(
        "SELECT COUNT(*) AS count FROM resource_members WHERE resource_type='CollaborationChatGroup' AND resource_id=%s AND (status='pending' OR entity_id='2000000000')",
        [groupId]
      )
      assert.equal(Number(rejected[0].count), 0)
      assert.equal((await request(`/api/v1/chat-groups/${groupId}`)).group.role, 'Owner')
      await click(control, 'group-start-thread')
      await control.command('fill', '[data-testid="create-thread-name"]', { value: title })
      await control.command('click', '[data-testid="create-thread-submit"]')
      await wait(control, 'thread-room', { text: title })
      threadId = new URL(
        JSON.parse(await control.command('snapshot', CONTENT)).location
      ).searchParams.get('threadId')
      assert.ok(threadId)
      const observer = await request(`/api/v1/loop-items/${threadId}`, { token: memberToken })
      assert.equal(observer.joined, false)
      assert.equal(observer.permissions.comment, false)
      const memberConnection = await connectSocket(memberToken)
      const packets = []
      memberConnection.on('wework:project_chat:message:created', message => packets.push(message))
      const subscribe = input =>
        memberConnection.timeout(uiTimeoutMs).emitWithAck('wework:project_chat:subscribe', {
          projectId: groupId,
          taskId: threadId,
          containerKind: 'chat_group',
          ...input,
        })
      assert.equal((await subscribe({})).ok, true)
      assert.equal((await subscribe({ containerKind: 'project' })).ok, false)
      assert.equal((await subscribe({ containerKind: 'invalid' })).ok, false)
      await send(memberToken, '未加入不能发言', { denied: true, connection: memberConnection })
      await send(cloud.authToken, '观察者查看不会订阅持续通知')
      assert.equal((await inbox()).length, 0)
      await participation({ joined: true })
      await send(memberToken, '另一位成员加入后的真实云端讨论', { connection: memberConnection })
      await wait(control, 'group-message-list', { text: '另一位成员加入后的真实云端讨论' })
      await send(cloud.authToken, '已加入成员收到持续提醒')
      const subscribed = (await inbox()).length
      assert.ok(subscribed > 0)
      await participation({ joined: true, notifications: 'muted' })
      await send(cloud.authToken, '静音后停止提醒')
      assert.equal((await inbox()).length, subscribed)
      await participation({ joined: false })
      await participation({ joined: true })
      assert.equal(
        (
          await request(`/api/v1/loop-items/${threadId}/participation`, { token: memberToken })
        ).participants.find(person => person.user_id === member.id).notifications,
        'muted'
      )
      await participation({ joined: true, notifications: 'all' })
      await control.command('waitFor', `${scoped('thread-room')} header`, {
        text: '2 人参与',
        timeoutMs: uiTimeoutMs,
      })
      const selfAvatars = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${CONTENT} [data-message-side="self"] [data-testid^="group-message-avatar-"]`
        )
      )
      const otherAvatars = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${CONTENT} [data-message-side="other"] [data-testid^="group-message-avatar-"]`
        )
      )
      assert.ok(
        selfAvatars.length && otherAvatars.length,
        'Both humans need visible sender avatars'
      )
      assert.ok(
        selfAvatars[0].left > otherAvatars[0].left,
        'Current-user messages must be on the right'
      )
      const discussion = await control.command('getText', scoped('group-message-list'))
      assert.ok(discussion.includes(owner.user_name) && discussion.includes(member.user_name))
      await capture(control, 'cloud-thread-two-person-discussion.png')

      const other = (
        await request('/api/v1/chat-groups', {
          method: 'POST',
          body: { name: '独立文件命名空间' },
          status: 200,
        })
      ).group
      const firstFile = await upload(groupId, 'first group content')
      const secondFile = await upload(other.id, 'second group content')
      await request(`/api/v1/cloud-projects/files/${secondFile.id}/content`, {
        token: memberToken,
        status: 404,
      })
      const keys = await cloud.queryDatabase(
        'SELECT id,object_key FROM loop_items WHERE id IN (%s,%s)',
        [firstFile.id, secondFile.id]
      )
      assert.equal(keys.length, 2)
      assert.notEqual(keys[0].object_key, keys[1].object_key)
      for (const [file, content, token] of [
        [firstFile, 'first group content', memberToken],
        [secondFile, 'second group content', cloud.authToken],
      ]) {
        const response = await fetch(
          `${cloud.backendUrl}/api/v1/cloud-projects/files/${file.id}/content`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        assert.equal(response.status, 200)
        assert.equal(await response.text(), content)
      }
      const delivery = await request(`/api/v1/loop-items/${threadId}/deliveries`, {
        method: 'POST',
        body: { title: '共享交付', markdown: '群成员可读的交付内容' },
        status: 201,
      })
      await request(`/api/v1/deliveries/${delivery.id}/finalize`, { method: 'POST', body: {} })
      assert.equal(
        (await request(`/api/v1/deliveries/${delivery.id}`, { token: memberToken })).markdown,
        '群成员可读的交付内容'
      )
      await reloadMainWindow(control)
      await wait(control, 'thread-room', { text: title })
      await wait(control, 'group-message-list', { text: '另一位成员加入后的真实云端讨论' })
      await click(control, 'thread-more')
      await control.command('click', '[data-testid="thread-menu-lifecycle"]')
      await wait(control, `thread-nav-${threadId}`, { visible: false })
      assert.equal((await request(`/api/v1/chat-groups/${groupId}`)).group.status, 'active')
      assert.equal(
        (await request('/api/v1/chat-group-navigation', { token: memberToken })).items.some(
          item => item.id === threadId
        ),
        false
      )
      await send(memberToken, '完成后仍能补充讨论')
      await wait(control, 'group-message-list', { text: '完成后仍能补充讨论' })
      await capture(control, 'cloud-thread-completed-discussion.png')
      await request(`/api/v1/chat-groups/${groupId}/members`, {
        method: 'POST',
        body: { user_id: member.id, role: 'Viewer' },
      })
      assert.equal(
        (await request(`/api/v1/loop-items/${threadId}/participation`, { token: memberToken }))
          .can_comment,
        false
      )
      await send(memberToken, '只读成员不能发言', { denied: true })
      await request(`/api/v1/chat-groups/${groupId}/members/${member.id}`, { method: 'DELETE' })
      await request(`/api/v1/loop-items/${threadId}`, { token: memberToken, status: 404 })
      await request(`/api/v1/deliveries/${delivery.id}`, { token: memberToken, status: 404 })
      await request(`/api/v1/cloud-projects/files/${firstFile.id}/content`, {
        token: memberToken,
        status: 404,
      })
      assert.equal((await inbox()).length, 0)
      await send(memberToken, '已移除成员不能发言', { denied: true, connection: memberConnection })
      await send(cloud.authToken, '撤权后的内容不能投递给仍在线的旧连接')
      assert.equal((await subscribe({})).ok, false)
      assert.equal(
        packets.some(message => message.content === '撤权后的内容不能投递给仍在线的旧连接'),
        false
      )
      await capture(control, 'cloud-thread-membership-revocation.png')
      await verifyMilestoneGroupAuthority()
      const migration = await verifyMigrationAssetCopies(control)
      await verifyLegacyScopeWriteSerialization(migration)
      await verifyConcurrentMemberAndMessageWrites()
      await verifyGroupManualExecution({
        control,
        request,
        owner,
        uiTimeoutMs,
        modelResponseTimeoutMs,
        modelRequests: () => manualModelRequests,
        captureScreenshot,
        member,
        memberToken,
      })
    },
  }
}
