import assert from 'node:assert/strict'

import { requestExecutor } from './executor-rpc.mjs'
import { selectWorkspaceIssueAgent, waitForValue } from './workspace-agent-setup.mjs'

/** Cancel real runtime selection after binding, then retry the same Issue and resource. */
export async function verifyLocalIssueAssigneeRecovery(
  control,
  { contentSelector, project, source, mode, marker, completion, timeoutMs, executionTimeoutMs }
) {
  const scoped = selector => `${contentSelector} ${selector}`
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  assert.equal(source.execution_policy?.mode, 'fixed', 'Recovery needs a configured runner')
  assert.equal(source.model_policy?.mode, 'fixed', 'Recovery needs a configured model')
  const name = `${source.name}-retry-${mode}`
  const title = `本地负责人失败恢复-${mode}-${process.pid}`
  const resource = await rpc('chat_agents.create', {
    project_id: 'default-work-items',
    agent: {
      name,
      display_name: title,
      namespace: source.namespace,
      runtime: source.runtime,
      execution_policy: { mode: 'user_select' },
      model_policy: { mode: 'user_select' },
      system_prompt: marker,
      execution_environment: source.execution_environment,
      execution_mode: source.execution_mode,
      execution_device_id: source.execution_device_id,
      created_by_user_id: source.created_by_user_id,
    },
  })
  const bindings = async () =>
    (await rpc('chat_agents.list', { project_id: project.id })).filter(
      candidate => candidate.name === name && candidate.namespace === source.namespace
    )
  assert.equal((await bindings()).length, 0, 'The recovery source must start unbound')
  await control.command('click', scoped('[data-testid="cloud-todo-detail-close"]'))
  await control.command('click', scoped('[data-testid="collaboration-issue-create"]'))
  await control.command('fill', scoped('[data-testid="cloud-todo-title"]'), { value: title })
  await control.command('fill', scoped('[data-testid="cloud-todo-detail-description"]'), {
    value: marker,
  })
  const create = mode === 'create'
  if (!create) {
    await control.command('clickWhenEnabled', scoped('[data-testid="cloud-todo-create-confirm"]'))
    await control.command('waitFor', scoped('[data-testid="cloud-todo-detail"]'), { text: title })
  }
  const trigger = scoped(
    `[data-testid="${create ? 'cloud-todo-create-assignee' : 'cloud-todo-detail-assignee'}"]`
  )
  await selectWorkspaceIssueAgent(control, trigger, resource.id, timeoutMs, mode)
  const save = scoped(`[data-testid="${create ? 'cloud-todo-create-confirm' : 'cloud-todo-save'}"]`)
  if (!create) {
    await control.command('waitFor', save, { text: '保存分配' })
    assert.equal(Number(await control.command('getElementCount', save)), 1)
    assert.equal(
      Number(
        await control.command('getElementCount', scoped('header [data-testid="cloud-todo-save"]'))
      ),
      0,
      'Pending assignment must expose its save action next to its owner'
    )
  }
  await control.command('clickWhenEnabled', save)
  await control.command('waitFor', '[data-testid="runner-selection-dialog"]', { timeoutMs })
  const createdBindings = await bindings()
  assert.equal(
    createdBindings.length,
    1,
    'Assignment must bind before requesting runtime selection'
  )
  const binding = createdBindings[0]
  assert.notEqual(binding.id, resource.id, 'Assignment must use a project binding')
  assert.deepEqual(binding.execution_policy, { mode: 'user_select' })
  assert.deepEqual(binding.model_policy, { mode: 'user_select' })
  await control.command('click', '[data-testid="runner-selection-cancel"]')
  await control.command('waitFor', scoped('[data-testid="cloud-todo-save-error"]'), {
    text: '已取消执行配置选择',
    timeoutMs,
  })
  const issue = (await rpc('todos.list', { project_id: project.id })).find(
    candidate => candidate.title === title
  )
  assert.ok(issue, 'The recovery Issue was not persisted')
  const readIssue = () => rpc('todos.get', { project_id: project.id, task_id: issue.id })
  const runs = async () =>
    (await rpc('executions.list', { project_id: project.id, include_terminal: true })).filter(
      candidate => candidate.loop_item_id === issue.id
    )
  assert.equal((await readIssue()).assignee_agent_id ?? null, null)
  assert.equal((await runs()).length, 0, 'Cancelled selection started an execution')
  assert.equal(
    await control.command('getAttribute', trigger, {
      value: 'data-value',
    }),
    `resource:${resource.id}`,
    'Failed assignment lost the resource selection needed for retry'
  )

  // Fixed devices can supply their default model without opening a dialog.
  // Repair the actual source and binding configuration after cancellation,
  // then retry the same form against the same persisted project Agent.
  for (const agent of [resource, binding]) {
    const configured = await rpc('chat_agents.update', {
      project_id: agent.project_id,
      agent_id: agent.id,
      agent: {
        version: agent.version,
        execution_policy: source.execution_policy,
        model_policy: source.model_policy,
      },
    })
    assert.deepEqual(configured.execution_policy, source.execution_policy)
    assert.deepEqual(configured.model_policy, source.model_policy)
  }
  await control.command('clickWhenEnabled', save)
  await control.command('waitFor', save, { visible: false, timeoutMs })
  await control.command('waitFor', scoped('[data-testid="cloud-task-activity-list"]'), {
    text: completion,
    timeoutMs: executionTimeoutMs,
  })
  const persisted = await waitForValue(
    readIssue,
    item => item.status === 'in_review',
    'The recovered assignment did not complete',
    executionTimeoutMs
  )
  assert.equal(persisted.id, issue.id)
  assert.equal(persisted.assignee_agent_id, binding.id, 'Retry persisted the workspace resource ID')
  assert.deepEqual(
    (await bindings()).map(candidate => candidate.id),
    [binding.id]
  )
  assert.equal(
    (await rpc('todos.list', { project_id: project.id })).filter(
      candidate => candidate.title === title
    ).length,
    1,
    'Retry created a duplicate Issue'
  )
  const completed = await runs()
  assert.equal(completed.length, 1, 'Retry duplicated the real execution')
  assert.equal(completed[0].agent_id, binding.id)
  assert.equal(completed[0].status, 'completed')
  assert.ok(
    completed[0].runtime_task_id,
    'The recovered assignment did not use a real runtime task'
  )
  await control.command(
    'waitFor',
    scoped(`[data-testid="cloud-todo-detail-assignee"][data-value="agent:${binding.id}"]`),
    { timeoutMs }
  )
}
