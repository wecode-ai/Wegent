import assert from 'node:assert/strict'
import { selectWhenOptionAvailable } from './workspace-flows.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

/** Use the real resource picker and assignment path in a group with no project. */
export async function verifyStandaloneGroupAgent({
  control,
  timeoutMs,
  executionTimeoutMs,
  completion,
  captureScreenshot,
}) {
  const content = '[data-workspace-tab-content][aria-hidden="false"]'
  const scoped = id => `${content} [data-testid="${id}"]`
  const wait = (id, extra = {}) =>
    control.command('waitFor', scoped(id), { timeoutMs, visible: true, ...extra })
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const catalog = await rpc('runtime.runner.catalog', {})
  const model = catalog.models.find(item => item.runtime === 'codex' && item.is_default)
  assert.ok(model?.local_model_id, 'A real configured Codex model is required')
  const name = `群可复用智能体-${process.pid}`
  const source = await rpc('chat_agents.create', {
    project_id: 'default-work-items',
    agent: {
      name,
      display_name: name,
      namespace: 'default',
      runtime: 'codex',
      model: model.local_model_id,
      model_type: 'runtime',
      model_namespace: 'default',
      allowed_models: [{ name: model.local_model_id, type: 'runtime', namespace: 'default' }],
      system_prompt: 'Review this group thread and report the result.',
      execution_environment: 'local',
      execution_mode: 'auto',
      execution_policy: { mode: 'project_pool' },
      model_policy: {
        mode: 'fixed',
        model: {
          runtime: model.runtime,
          provider: model.provider,
          model_id: model.model_id,
          source: 'native',
        },
      },
      created_by_user_id: 0,
    },
  })
  await control.command('clickWhenEnabled', scoped('group-create-open'), {
    timeoutMs,
    visible: true,
  })
  await control.command('fill', '[data-testid="create-group-name"]', {
    value: `群智能体资源验收-${process.pid}`,
  })
  await control.command('select', '[data-testid="create-group-store"]', { value: 'local' })
  await control.command('clickWhenEnabled', '[data-testid="create-group-submit"]', {
    timeoutMs,
    visible: true,
  })
  await wait('group-room')
  const groupId = new URL(
    JSON.parse(await control.command('snapshot', content)).location
  ).searchParams.get('groupId')
  assert.ok(groupId)
  const executorStatus = JSON.parse(await control.command('getLocalExecutorStatus', 'body'))
  assert.ok(executorStatus.deviceId)
  await control.command('clickWhenEnabled', scoped('group-tab-settings'), {
    timeoutMs,
    visible: true,
  })
  await wait('group-resource-settings')
  await control.command('clickWhenEnabled', scoped('group-resource-tab-devices'), {
    timeoutMs,
    visible: true,
  })
  await control.command('clickWhenEnabled', scoped('group-execution-device-add'), {
    timeoutMs,
    visible: true,
  })
  await control.command('clickWhenEnabled', scoped('group-execution-device-candidate-0'), {
    timeoutMs,
    visible: true,
  })
  await wait('group-execution-device-0')
  const authorized = await rpc('chat_groups.get', { group_id: groupId })
  assert.ok(authorized.group.configuration.execution_environment.devices[executorStatus.deviceId])
  await captureScreenshot(control, 'group-device-explicit-consent-no-project.png', content)
  await control.command('clickWhenEnabled', scoped('group-resource-tab-agents'), {
    timeoutMs,
    visible: true,
  })
  await control.command(
    'clickWhenEnabled',
    `${scoped('group-resource-settings')} [data-testid="project-agent-add"]`,
    { timeoutMs, visible: true }
  )
  await control.command('clickWhenEnabled', `[data-testid="project-agent-option-${source.id}"]`, {
    timeoutMs,
    visible: true,
  })
  await control.command('clickWhenEnabled', '[data-testid="project-agent-wegent-create"]', {
    timeoutMs,
    visible: true,
  })
  const binding = await waitForValue(
    () => rpc('chat_agents.list', { project_id: groupId }),
    rows => rows.find(row => row.name === name),
    'The resource picker did not persist the group Agent binding',
    timeoutMs
  )
  assert.notEqual(binding.id, source.id)
  assert.equal(binding.project_id, groupId)
  await captureScreenshot(control, 'group-thread-agent-config-no-project.png', content)
  await control.command('clickWhenEnabled', scoped('group-tab-chat'), { timeoutMs, visible: true })
  await control.command('clickWhenEnabled', scoped('group-start-thread'), {
    timeoutMs,
    visible: true,
  })
  const title = `本群智能体执行-${process.pid}`
  await control.command('fill', '[data-testid="create-thread-name"]', { value: title })
  await control.command('clickWhenEnabled', '[data-testid="create-thread-submit"]', {
    timeoutMs,
    visible: true,
  })
  await wait('thread-room', { text: title })
  const threadId = new URL(
    JSON.parse(await control.command('snapshot', content)).location
  ).searchParams.get('threadId')
  assert.ok(threadId)
  assert.equal((await rpc('chat_groups.project_link.get', { thread_id: threadId })).project, null)
  await control.command('clickWhenEnabled', scoped('thread-settings'), { timeoutMs, visible: true })
  await wait('thread-settings-assignee')
  await selectWhenOptionAvailable(
    control,
    scoped('thread-settings-assignee'),
    `agent:${binding.id}`,
    timeoutMs
  )
  const assigned = await waitForValue(
    () => rpc('todos.get', { project_id: groupId, task_id: threadId }),
    task => (task.assignee_agent_id === binding.id ? task : false),
    'The group thread did not retain its selected group Agent',
    timeoutMs
  )
  assert.equal(assigned.cloud_project_id, groupId)
  const resolution = await rpc('chat_agents.resolve_for_task', {
    project_id: groupId,
    task_id: threadId,
    assignee_type: 'agent',
    assignee_id: binding.id,
  })
  assert.equal(resolution.work_owner_id, groupId)
  assert.equal(resolution.resource_owner_id, groupId)
  await control.command('clickWhenEnabled', scoped('thread-settings-close'), {
    timeoutMs,
    visible: true,
  })
  await wait('group-message-list', { text: completion, timeoutMs: executionTimeoutMs })
  await waitForValue(
    () => rpc('executions.list', { project_id: groupId, include_terminal: true }),
    rows => rows.find(row => row.loop_item_id === threadId && row.status === 'completed'),
    'The assigned group Agent did not complete a real runtime execution',
    executionTimeoutMs
  )
  await captureScreenshot(control, 'group-thread-agent-execution-no-project.png', content)
  await rpc('chat_agents.resolve_for_task', {
    project_id: groupId,
    task_id: threadId,
    assignee_type: 'agent',
    assignee_id: binding.id,
  })
  const currentBinding = (await rpc('chat_agents.list', { project_id: groupId })).find(
    row => row.id === binding.id
  )
  assert.ok(currentBinding, 'The active group binding disappeared before revocation')
  await rpc('chat_agents.archive', {
    project_id: groupId,
    agent_id: binding.id,
    version: currentBinding.version,
  })
  await assert.rejects(
    () =>
      rpc('chat_agents.resolve_for_task', {
        project_id: groupId,
        task_id: threadId,
        assignee_type: 'agent',
        assignee_id: binding.id,
      }),
    /unavailable|authorized|active/i
  )
}
