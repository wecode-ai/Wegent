import { verifyIssueRuntimeTitleIsolation } from './issue-runtime-title-isolation.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import {
  assert,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
  selectE2EModel,
} from './shared.mjs'

async function waitForBinding(control, projectId, itemId) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let binding
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const task = snapshot.workbench?.currentRuntimeTask ?? snapshot.pane?.currentRuntimeTask
    if (task) {
      binding = await requestExecutor(
        control,
        'runtime_tasks.context',
        {
          device_id: task.deviceId,
          task_id: task.taskId,
        },
        DEFAULT_STEP_TIMEOUT_MS
      )
      if (
        binding?.cloud_project_id === projectId &&
        binding.loop_item_id &&
        (!itemId || binding.loop_item_id === itemId)
      )
        return binding
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`First message did not persist the draft binding: ${JSON.stringify(binding)}`)
}

async function verifyDraft(control, project, existingItem) {
  const rpc = (method, params) => requestExecutor(control, method, params, DEFAULT_STEP_TIMEOUT_MS)
  const beforeItems = await rpc('todos.list', { project_id: project.id })
  const before = JSON.parse(await control.command('snapshot', 'body'))
  await control.command('click', '[data-testid="workspace-tab-add"]')
  await control.command('click', '[data-testid="workspace-tab-add-task"]')
  const opened = await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.some(
        id => id.startsWith('workspace-tab-task-') && !before.testIds.includes(id)
      ),
    'Opening a new draft did not create a task tab'
  )
  const tab = opened.testIds.find(
    id => id.startsWith('workspace-tab-task-') && !before.testIds.includes(id)
  )
  assert.ok(tab, 'The new draft task tab was not found')
  const tabId = tab.slice('workspace-tab-'.length)
  const content = `[data-testid="workspace-tab-content-${tabId}"]`
  const composer = `${content} [data-testid="chat-message-input"][contenteditable="true"]`
  const chooseProject = async () => {
    const projectPicker = `${content} button[data-testid="project-space-context-pill"]`
    await control.command('waitFor', projectPicker, { visible: true })
    await control.command('click', projectPicker)
    await control.command(
      'markElementWithText',
      '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
      { text: project.name, value: 'draft-target-project', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    await control.command('click', '[data-e2e-anchor-id="draft-target-project"]')
    await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
      text: project.name,
      visible: true,
    })
  }
  await control.command('waitFor', composer, { visible: true })
  await chooseProject()
  if (existingItem) {
    await control.command(
      'waitFor',
      `[data-testid="task-board-association-item-${existingItem.id}"]`,
      {
        text: existingItem.title,
        visible: true,
      }
    )
  }
  await control.command(
    'click',
    existingItem
      ? `[data-testid="task-board-association-item-${existingItem.id}"]`
      : '[data-testid="task-board-association-create"]'
  )
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    visible: false,
  })
  // Cancel after selecting a target; submission must retain the original choice.
  await chooseProject()
  await control.command('click', '[data-testid="task-board-association-close"]')
  assert.equal(
    Number(await control.command('getElementCount', `${content} [data-testid="message-user"]`)),
    0,
    'Selecting a draft Issue sent a user message'
  )
  assert.deepEqual(
    await rpc('todos.list', { project_id: project.id }),
    beforeItems,
    'Draft selection or cancellation changed board cards before submission'
  )
  await selectE2EModel(control)
  control.setScenario('checkpoint_task')
  const marker = existingItem ? 'LINK_EXISTING_DRAFT' : 'CREATE_NEW_DRAFT'
  const prompt = `${marker}: ${CHECKPOINT_TASK_PROMPT}`
  await control.command('fill', composer, {
    value: prompt,
  })
  await control.command('press', composer, { key: 'Enter' })
  await control.command('waitFor', `${content} [data-testid="message-assistant"]`, {
    text: CHECKPOINT_TASK_COMPLETION_TEXT,
  })
  const binding = await waitForBinding(control, project.id, existingItem?.id)
  const persisted = await rpc('todos.get', {
    project_id: project.id,
    task_id: binding.loop_item_id,
  })
  const afterItems = await rpc('todos.list', { project_id: project.id })
  assert.equal(afterItems.length, beforeItems.length + (existingItem ? 0 : 1))
  assert.equal(persisted.id, existingItem?.id ?? binding.loop_item_id)
  if (existingItem) assert.equal(persisted.title, existingItem.title)
  else {
    assert.ok(persisted.title.startsWith(`${marker}: `), 'New card lost the first message title')
    assert.equal(persisted.description, prompt, 'New card lost the full first message')
  }
  const bindings = await rpc('todos.bindings', { task_id: persisted.id })
  assert.equal(
    bindings.filter(value => value.task_id === binding.task_id).length,
    1,
    'The Issue did not retain exactly one binding for the submitted Runtime task'
  )
  await control.command('waitFor', `${content} [data-testid="work-item-guide-summary-title"]`, {
    text: persisted.title,
    visible: true,
  })
  await verifyIssueRuntimeTitleIsolation(control, content, project, persisted, binding)
  await control.command('click', `[data-testid="workspace-tab-close-${tabId}"]`)
  console.log(`[e2e] Draft ${existingItem ? 'association' : 'creation'} persisted: ${persisted.id}`)
}

export async function verifyNewTaskBoardAssociation(control, projectName, issueTitle) {
  const projects = await requestExecutor(control, 'projects.list', {}, DEFAULT_STEP_TIMEOUT_MS)
  const project = projects.find(value => value.name === projectName)
  assert.ok(project, 'The draft target project fixture is missing')
  const items = await requestExecutor(
    control,
    'todos.list',
    { project_id: project.id },
    DEFAULT_STEP_TIMEOUT_MS
  )
  const existingItem = items.find(value => value.title === issueTitle)
  assert.ok(existingItem, 'The existing Issue fixture is missing')
  await verifyDraft(control, project, null)
  await verifyDraft(control, project, existingItem)
}
