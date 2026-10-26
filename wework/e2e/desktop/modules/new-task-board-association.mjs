import { verifyIssueRuntimeTitleIsolation } from './issue-runtime-title-isolation.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import {
  assert,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
  join,
  resultDir,
  selectE2EModel,
  writeFile,
} from './shared.mjs'

async function verifyAssociationDialogLayout(control, existingItem) {
  const search = '[data-testid="task-board-association-search"]'
  const item = `[data-testid="task-board-association-item-${existingItem.id}"]`
  await control.command(
    'waitFor',
    '[data-testid="task-board-association-list"][aria-busy="false"]',
    {
      visible: true,
      stableMs: 100,
    }
  )
  await control.command('fill', search, { value: 'NO_MATCH_ASSOCIATION_LAYOUT' })
  await control.command('waitFor', '[data-testid="task-board-association-empty"]', {
    visible: true,
    stableMs: 100,
  })
  await control.command('fill', search, { value: existingItem.id })
  await control.command('waitFor', item, { visible: true, stableMs: 100 })
  await control.command('fill', search, { value: '' })
  await control.command('waitFor', '[data-testid="task-board-association-list"] button', {
    visible: true,
    stableMs: 100,
  })
  const scrollTop = Number(
    await control.command('scrollToBottomAsUser', '[data-testid="task-board-association-list"]')
  )
  assert.ok(scrollTop > 0, 'The long task list fixture must overflow')
  await control.command('waitFor', '[data-testid="task-board-association-create"]', {
    visible: true,
    stableMs: 100,
  })
  await control.command('fill', search, { value: existingItem.id })
  await control.command('waitFor', item, { visible: true, stableMs: 100 })

  const sample = JSON.parse(await control.command('stopElementMetricsSampling', 'body'))
  await writeFile(
    join(resultDir, 'task-board-association-layout-frames.json'),
    JSON.stringify(sample, null, 2)
  )
  const frames = sample.frames.filter(frame => frame.elements.length > 0)
  assert.ok(frames.length > 2, 'Dialog stability requires multiple rendered frames')
  const baseline = frames[0].elements
  for (const frame of frames) {
    assert.equal(frame.elements.length, 3, 'The dialog, search and create button must stay mounted')
    frame.elements.forEach((element, index) => {
      assert.equal(element.identity, baseline[index].identity, 'Dialog controls must not remount')
      for (const property of ['left', 'top', 'width', 'height']) {
        assert.ok(
          Math.abs(element[property] - baseline[index][property]) <= 1,
          `Dialog control ${index} changed ${property} during loading, filtering or scrolling`
        )
      }
    })
  }
}

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
  const chooseProject = async (verifyLayout = false) => {
    const projectPicker = `${content} button[data-testid="project-space-context-pill"]`
    await control.command('waitFor', projectPicker, { visible: true })
    await control.command('click', projectPicker)
    await control.command(
      'markElementWithText',
      '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
      { text: project.name, value: 'draft-target-project', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    if (verifyLayout) {
      await control.command('startElementMetricsSampling', content, {
        value: String(DEFAULT_STEP_TIMEOUT_MS),
        target: ['dialog', 'search', 'create']
          .map(id => `[data-testid="task-board-association-${id}"]`)
          .join(', '),
      })
    }
    await control.command('click', '[data-e2e-anchor-id="draft-target-project"]')
    await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
      text: project.name,
      visible: true,
    })
    if (verifyLayout) await verifyAssociationDialogLayout(control, existingItem)
  }
  await control.command('waitFor', composer, { visible: true })
  await chooseProject(Boolean(existingItem))
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
  const layoutFixtures = []
  try {
    for (let index = 0; index < 12; index += 1) {
      layoutFixtures.push(
        await requestExecutor(
          control,
          'todos.create',
          {
            project_id: project.id,
            todo: { title: `Association layout fixture ${index}`, status: 'pending' },
          },
          DEFAULT_STEP_TIMEOUT_MS
        )
      )
    }
    await verifyDraft(control, project, existingItem)
  } finally {
    for (const fixture of layoutFixtures) {
      await requestExecutor(
        control,
        'todos.update',
        {
          project_id: project.id,
          task_id: fixture.id,
          todo: { version: fixture.version, status: 'completed' },
        },
        DEFAULT_STEP_TIMEOUT_MS
      )
      await requestExecutor(
        control,
        'todos.archive',
        { project_id: project.id, task_id: fixture.id },
        DEFAULT_STEP_TIMEOUT_MS
      )
    }
  }
}
