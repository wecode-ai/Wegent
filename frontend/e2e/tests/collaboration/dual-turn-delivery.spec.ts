// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { createProjectChatClient } from '../../../../packages/chat-core/src/project-chat'
import { writeFile } from 'node:fs/promises'
import { eventBase, eventResult } from '../../../../packages/chat-core/src/response-api-decoder'
import { expect, test } from '@playwright/test'
import {
  createCloudRuntimeIpcClient,
  type RuntimeEvent,
} from '../../../../packages/chat-core/src/runtime-ipc'
import { createRuntimeConversationClient } from '../../../../packages/chat-core/src/runtime-conversation-client'
import {
  configureIssueDispatchModelScenario,
  createIssueDispatchMockModel,
  initializeProjectExecutionEnvironment,
  createProjectAgent,
  deleteIssueDispatchMockModel,
} from '../../utils/issue-dispatch-test-support'
import {
  authHeaders,
  getScenarioModelBodies,
  PROVIDER_NATIVE_API_URL,
} from '../../utils/provider-native-test-support'

interface Execution {
  loopItemId: string
  runtimeTaskId: string
  runtimeDeviceId: string
  status: string
}

test('preserves one dispatched model answer across the Issue, device event stream and recovered conversation', async ({
  page,
  request,
}, info) => {
  test.setTimeout(150_000)
  const suffix = Date.now().toString(36)
  const model = await createIssueDispatchMockModel(request, suffix, 'openai-responses')
  const connection = {
    socketBaseUrl: PROVIDER_NATIVE_API_URL,
    socketPath: '/socket.io',
    getToken: () => model.token,
    clientOrigin: 'web' as const,
  }
  const ipc = createCloudRuntimeIpcClient(connection)
  const chat = createProjectChatClient(connection)
  const conversation = createRuntimeConversationClient(ipc)
  let clear: (() => Promise<void>) | undefined
  try {
    async function create(path: string, data: object) {
      const response = await request.post(PROVIDER_NATIVE_API_URL + path, {
        headers: authHeaders(model.token),
        data,
      })
      expect(response.ok(), await response.text()).toBe(true)
      return (await response.json()) as { id: string }
    }
    const workspace = await create('/api/v1/workspaces', { name: 'Release workspace ' + suffix })
    const project = await create('/api/v1/workspaces/' + workspace.id + '/projects', {
      name: 'Release project ' + suffix,
      task_provider: 'local',
      visibility: 'private',
    })
    const issue = await create('/api/v1/cloud-projects/' + project.id + '/loop-items', {
      title: 'Verify the release notes',
      description: 'Return the completed checklist.',
      status: 'pending',
      priority: 'none',
      tags: [],
    })
    const fixture = {
      projectId: project.id,
      issueId: issue.id,
      projectPath: '/collaboration/workspaces/' + workspace.id + '/projects/' + project.id,
    }
    await page.goto(fixture.projectPath, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('collaboration-board')).toBeVisible({ timeout: 35_000 })
    await initializeProjectExecutionEnvironment(page)
    const agent = await createProjectAgent(page, 'Release reviewer', model.modelName)
    const match = 'task_id: ' + fixture.issueId
    const answer = 'Release checklist verified ' + suffix
    clear = await configureIssueDispatchModelScenario(request, match, [
      { preamble: { text: answer, startedPhase: 'final_answer', completedPhase: 'final_answer' } },
    ])
    const initial = await chat.subscribe(project.id, issue.id, 0, () => {})
    initial.unsubscribe()
    const events: RuntimeEvent[] = []
    await ipc.subscribe(event => events.push(event))
    await page.goto(fixture.projectPath + '/issues/' + fixture.issueId)
    await page.getByTestId('cloud-todo-detail-assignee').click()
    await page.getByTestId('cloud-todo-detail-assignee-option-agent:' + agent.id).click()
    const executions = async () => {
      const response = await request.get(
        PROVIDER_NATIVE_API_URL +
          '/api/v1/cloud-projects/' +
          fixture.projectId +
          '/executions?include_terminal=true',
        { headers: authHeaders(model.token) }
      )
      expect(response.ok(), await response.text()).toBe(true)
      const body = (await response.json()) as { items: Execution[] }
      return body.items.filter(item => item.loopItemId === fixture.issueId)
    }
    await expect
      .poll(async () => (await executions()).map(row => row.status), {
        timeout: 80_000,
        message: 'Exactly one assigned execution should complete',
      })
      .toEqual(['completed'])
    const [execution] = await executions()
    const address = {
      projectSession: { projectId: fixture.projectId, issueId: fixture.issueId },
      taskId: execution.runtimeTaskId,
      deviceId: execution.runtimeDeviceId,
    }
    expect(address.taskId).toBeTruthy()
    expect(address.deviceId).toBeTruthy()
    expect(await getScenarioModelBodies(request, match)).toHaveLength(1)
    const delivery = page.getByTestId(/^cloud-task-activity-card-/).filter({ hasText: answer })
    await expect(delivery).toHaveCount(1)
    const issueImage = info.outputPath('issue-delivery.png')
    await page.screenshot({ path: issueImage })
    await info.attach('issue-delivery', { path: issueImage, contentType: 'image/png' })
    const sessionEvents = events.filter(event => eventBase(event.payload).taskId === address.taskId)
    expect(sessionEvents.filter(event => event.event === 'response.completed')).toHaveLength(1)
    const streamedText = sessionEvents
      .filter(event => event.event === 'response.output_text.delta')
      .map(event => eventResult(event.payload).delta)
      .join('')
    const eventShapes = info.outputPath('runtime-events.json')
    await writeFile(
      eventShapes,
      JSON.stringify(
        sessionEvents.map(e => ({
          name: e.event,
          fields: Object.keys(eventResult(e.payload)),
          containsAnswer: JSON.stringify(eventResult(e.payload)).includes(answer),
        }))
      )
    )
    await info.attach('runtime-events', { path: eventShapes, contentType: 'application/json' })
    expect(streamedText).toBe(answer)
    const replay = await chat.subscribe(
      project.id,
      issue.id,
      initial.snapshot.latestSequence,
      () => {}
    )
    const deliveries = replay.snapshot.messages.filter(message => message.content === answer)
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({
      status: 'completed',
      taskId: issue.id,
      projectId: project.id,
    })
    replay.unsubscribe()
    await ipc.reconnect()
    const history = await conversation.getTranscript({ ...address, refresh: true })
    const replies = history.turns.flatMap(turn =>
      turn.items.filter(item => item.type === 'assistant_text' && item.content === answer)
    )
    expect(replies).toHaveLength(1)
    await delivery.getByTestId(/^cloud-task-activity-execution-badge-/).click()
    const panel = page.getByTestId('runtime-execution-detail-body')
    await expect(panel.getByText(answer, { exact: true })).toBeVisible()
    const sessionImage = info.outputPath('recovered-session.png')
    await page.screenshot({ path: sessionImage })
    await info.attach('recovered-session', { path: sessionImage, contentType: 'image/png' })
  } finally {
    chat.dispose()
    ipc.dispose()
    await clear?.()
    await deleteIssueDispatchMockModel(request, model)
  }
})
