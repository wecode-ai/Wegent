import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'

import { createWorker } from '../../../../packages/wework-worker/index.js'
import { selectCollaborationProjectView } from '../modules/collaboration-project-navigation.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const COMPOSER = `${CONTENT} [data-testid="cloud-task-activity-composer"]`
const SEND = `${CONTENT} [data-testid="task-comment-form"] [data-testid="send-message-button"]`
const UI_STEP_MS = 10_000
const selector = id => `[data-testid="${id}"]`

function deadline(promise, description) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(description)), UI_STEP_MS)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export async function createDesktopScenario({ captureScreenshot, workbenchReadyTimeoutMs }) {
  let cloud
  let project
  let issue
  let worker
  let proxy
  let hookRequests = 0
  const receivedHook = Promise.withResolvers()
  const externalService = createServer(async (request, response) => {
    hookRequests++
    try {
      let body = ''
      for await (const chunk of request) body += chunk
      assert.equal(request.method, 'POST')
      assert.match(request.headers['content-type'], /^application\/xml/)
      assert.ok(body.includes('检查 &amp; &lt;部署&gt;'))
      const field = name => {
        const result = body.match(new RegExp(`<${name}>([^<]+)</${name}>`))
        assert.ok(result, `Hook template omitted ${name}`)
        return result[1]
      }
      receivedHook.resolve({
        invocationId: field('invocationId'),
        deliveryId: field('deliveryId'),
        url: field('callbackUrl'),
        token: field('callbackToken'),
      })
      response.writeHead(202).end()
    } catch (error) {
      receivedHook.reject(error)
      response.writeHead(400).end()
    }
  })
  // Record errors immediately, then observe them at the Hook delivery step.
  receivedHook.promise.catch(() => {})
  externalService.listen(0, '127.0.0.1')
  await once(externalService, 'listening')
  const origin = `http://127.0.0.1:${externalService.address().port}`

  async function request(path, input) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method: input ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      body: input && JSON.stringify(input),
      signal: AbortSignal.timeout(UI_STEP_MS),
    })
    assert.ok(response.ok, `${path} failed with HTTP ${response.status}`)
    return response.json()
  }

  return {
    requiresCloudEnvironment: true,
    requiresRemoteExecutor: false,
    backendEnv: { WEWORK_EXTERNAL_HOOK_ORIGINS: origin },
    async prepareCloud(value) {
      cloud = value
      const workspace = await request('/api/v1/workspaces', {
        name: `External agent story ${process.pid}`,
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        projectKey: 'EXTERNAL',
        name: '外部智能体验收',
        taskProvider: 'local',
        providerConfig: {},
        visibility: 'private',
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        title: '核对昨晚的部署记录',
      })
    },
    async verify(control) {
      const step = (action, id, options = {}) =>
        control.command(action, selector(id), { timeoutMs: UI_STEP_MS, ...options })
      const click = id => step('clickWhenEnabled', id)
      const wait = (id, options) => step('waitFor', id, options)
      const fill = (id, value) => step('fill', id, { value })
      const capture = name => captureScreenshot(control, `external-agent-${name}.png`)
      async function openIssue() {
        await control.command('openWeworkScheme', 'body', {
          value: `wework://boards/${project.id}/issues/${issue.id}`,
        })
        await control.command('waitFor', COMPOSER, { timeoutMs: UI_STEP_MS })
      }
      async function openConfiguration(name) {
        await click('project-agent-add')
        await click('project-agent-connect-external')
        await fill('external-agent-name', name)
      }
      async function mention(agent, text) {
        await click('task-comment-form-mention')
        const candidate = `collaboration-issue-mention-agent-${agent.id}`
        await wait(candidate, { text: '外部智能体', visible: true })
        await capture(`mention-${agent.name}`)
        await click(candidate)
        await control.command('pasteText', COMPOSER, { value: text })
        await control.command('clickWhenEnabled', SEND, { timeoutMs: UI_STEP_MS })
      }
      function replySelector(id) {
        return `[data-message-id="${id}"]`
      }
      async function captureReply(id, name) {
        await control.command('scrollIntoView', replySelector(id))
        await capture(name)
      }
      async function verifyReply(id, text) {
        await control.command('waitFor', replySelector(id), { text, timeoutMs: UI_STEP_MS })
        assert.equal(Number(await control.command('getElementCount', replySelector(id))), 1)
      }

      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', selector('workspace-tab-select-fixed-board'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await click('workspace-tab-select-fixed-board')
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await selectCollaborationProjectView(control, CONTENT, 'manage', UI_STEP_MS)
      await click('collaboration-project-settings-agents')

      await openConfiguration('部署 Hook')
      await fill('external-agent-hook-url', `${origin}/tasks`)
      await click('external-agent-hook-format')
      await click('external-agent-hook-format-option-application/xml')
      await capture('hook-configuration')
      await click('external-agent-save')
      await wait('external-agent-form', { visible: false })

      await openConfiguration('部署 Worker')
      await click('external-agent-transport')
      await click('external-agent-transport-option-worker')
      await capture('worker-configuration')
      await click('external-agent-save')
      await wait('external-agent-worker-token')
      await wait('project-agent-list', { text: '部署 Worker' })
      await capture('worker-credential')
      const token = await step('getValue', 'external-agent-worker-token')
      const endpoint = await step('getValue', 'external-agent-worker-endpoint')
      const probe = createWorker({ endpoint, token })
      probe.onTask(() => {
        throw new Error('Configuration alone must not dispatch a task')
      })
      try {
        await deadline(
          probe.start(),
          'The Worker could not connect with the displayed address and credential'
        )
        await click('external-agent-check-connection')
        await wait('external-agent-worker-status', { text: 'Worker 已连接' })
        await capture('worker-connected')
      } finally {
        probe.stop()
      }
      await click('external-agent-save')
      await wait('external-agent-form', { visible: false })
      const agents = await request(`/api/v1/cloud-projects/${project.id}/chat-agents`)
      const hookAgent = agents.find(agent => agent.name === '部署 Hook')
      const workerAgent = agents.find(agent => agent.name === '部署 Worker')
      assert.ok(hookAgent && workerAgent)
      assert.equal(hookAgent.runtime, 'external')
      assert.equal(workerAgent.runtime, 'external')
      assert.equal(
        hookAgent.canUse,
        true,
        'Project members must be allowed to invoke the registered Hook'
      )
      assert.equal(
        workerAgent.canUse,
        true,
        'Project members must be allowed to invoke the registered Worker'
      )

      await openIssue()
      await mention(hookAgent, '检查 & <部署>')
      const hook = await deadline(
        receivedHook.promise,
        'The configured XML Hook did not receive the issue'
      )
      const callback = (seq, type, text, token = hook.token) =>
        fetch(hook.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invocationId: hook.invocationId,
            deliveryId: hook.deliveryId,
            seq,
            type,
            text,
          }),
          signal: AbortSignal.timeout(UI_STEP_MS),
        })
      const rejected = await callback(1, 'append', '拒绝写入', 'invalid')
      assert.equal(rejected.status, 401)
      assert.ok((await callback(1, 'progress', 'Hook 正在查找部署记录')).ok)
      await verifyReply(hook.invocationId, 'Hook 正在查找部署记录')
      await captureReply(hook.invocationId, 'hook-progress')
      assert.ok((await callback(2, 'append', 'Hook 找到三条记录。')).ok)
      assert.ok((await callback(2, 'append', 'Hook 找到三条记录。')).ok)
      await verifyReply(hook.invocationId, 'Hook 找到三条记录。')
      const hookText = await control.command('getText', replySelector(hook.invocationId))
      assert.equal(hookText.split('Hook 找到三条记录。').length - 1, 1)
      await captureReply(hook.invocationId, 'hook-streaming')
      assert.ok((await callback(3, 'succeeded')).ok)
      await wait(`cloud-task-activity-execution-badge-${hook.invocationId}`, { text: '已完成' })
      await captureReply(hook.invocationId, 'hook-completed')

      // Queue the invocation while offline. A real connected Worker must claim it.
      await mention(workerAgent, '检查部署')
      proxy = new TransportFaultProxy(cloud.backendUrl)
      await proxy.start()
      const streamed = Promise.withResolvers()
      const finish = Promise.withResolvers()
      const handlerEntered = Promise.withResolvers()
      let handled = 0
      worker = createWorker({ endpoint: proxy.url, token, onError: streamed.reject })
      worker.onTask(async (task, reply) => {
        handled++
        handlerEntered.resolve(task.invocationId)
        await reply.progress('Worker 正在核对部署')
        await reply.append('Worker 已核对三条记录。')
        streamed.resolve(task.invocationId)
        await finish.promise
        await reply.append(' 重连后继续。')
      })
      await deadline(worker.start(), 'Worker could not authenticate over WebSocket')
      await deadline(handlerEntered.promise, 'Worker did not claim the offline issue invocation')
      const workerId = await deadline(streamed.promise, 'Worker did not stream its first reply')
      await verifyReply(workerId, 'Worker 正在核对部署')
      await verifyReply(workerId, 'Worker 已核对三条记录。')
      await captureReply(workerId, 'worker-streaming')
      proxy.disconnectWebSockets(true)
      finish.resolve()
      proxy.disconnectWebSockets(false)
      await verifyReply(workerId, '重连后继续。')
      await wait(`cloud-task-activity-execution-badge-${workerId}`, { text: '已完成' })
      await captureReply(workerId, 'worker-completed')
      assert.equal(handled, 1, 'Reconnection must resume the handler without calling it again')

      await click('cloud-todo-detail-close')
      await openIssue()
      await verifyReply(hook.invocationId, 'Hook 找到三条记录。')
      await verifyReply(workerId, '重连后继续。')
      const cards = await control.command(
        'getElementCount',
        '[data-testid^="cloud-task-activity-reply-toggle-"]'
      )
      assert.ok(Number(cards) >= 2, 'The external activity must preserve its discussion threads')
      const externalReply = `[data-testid="cloud-task-activity-reply-toggle-${hook.invocationId}"]`
      const replyActions = await control.command('getText', externalReply)
      assert.equal(replyActions, '回复')
      await control.command('clickWhenEnabled', externalReply, { timeoutMs: UI_STEP_MS })
      await wait('issue-reply-composer')
      await control.command('pasteText', COMPOSER, { value: '我已核对这次外部回复。' })
      await control.command('clickWhenEnabled', SEND, { timeoutMs: UI_STEP_MS })
      await control.command('waitFor', CONTENT, {
        text: '我已核对这次外部回复。',
        timeoutMs: UI_STEP_MS,
      })
      await wait('issue-reply-composer', { visible: false })
      assert.equal(hookRequests, 1, 'Replying to external output must not dispatch the Hook again')
      await capture('discussion-reply')
    },
    async cleanup() {
      worker?.stop()
      await proxy?.stop()
      externalService.closeAllConnections()
      await new Promise(resolve => externalService.close(resolve))
    },
  }
}
