import {
  verifyIssueRuntimeReply,
  verifyIssueRuntimeTitleIsolation,
} from './issue-runtime-title-isolation.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { prepareGroupThreadCreation } from './collaboration-board-issue.mjs'
import { captureVerificationScreenshot } from './workspace-flows.mjs'
import {
  assert,
  CHECKPOINT_TASK_PROMPT,
  DEFAULT_STEP_TIMEOUT_MS,
  join,
  resultDir,
  selectE2EModel,
  sendPromptUntilScenarioRequest,
  writeFile,
} from './shared.mjs'

async function verifyAssociationDialogLayout(control, existingItem) {
  const dialog = '[data-testid="task-board-association-dialog"]'
  const search = '[data-testid="task-board-association-search"]'
  const item = `[data-testid="task-board-association-item-${existingItem.id}"]`
  await control.command('waitFor', `body > .z-modal > ${dialog}`, { visible: true })
  const [dialogBounds] = JSON.parse(await control.command('getElementMetrics', dialog))
  const [viewportBounds] = JSON.parse(await control.command('getElementMetrics', 'body'))
  assert.ok(
    Math.abs(dialogBounds.left + dialogBounds.width / 2 - viewportBounds.width / 2) <= 1,
    'The association dialog must be centered above all workbench panes'
  )
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

export async function waitForBinding(control, projectId, itemId) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let binding
  let lastError
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
    const task = snapshot.workbench?.currentRuntimeTask ?? snapshot.pane?.currentRuntimeTask
    if (task) {
      try {
        binding = await requestExecutor(
          control,
          'runtime_tasks.context',
          {
            device_id: task.deviceId,
            task_id: task.taskId,
          },
          DEFAULT_STEP_TIMEOUT_MS
        )
      } catch (error) {
        // The renderer exposes the new task before the Runtime persists its link.
        lastError = error
        binding = undefined
      }
      if (
        binding?.cloud_project_id === projectId &&
        binding.loop_item_id &&
        (!itemId || binding.loop_item_id === itemId)
      )
        return binding
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(
    `First message did not persist the draft binding: ${JSON.stringify(binding)}` +
      (lastError ? ` (last error: ${lastError.message})` : '')
  )
}

export async function waitForViewedIssueRead(control, groupId, issueId) {
  const rpc = (method, params) => requestExecutor(control, method, params, DEFAULT_STEP_TIMEOUT_MS)
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  let issue
  while (Date.now() < deadline) {
    issue = await rpc('todos.get', { project_id: groupId, task_id: issueId })
    assert.equal(issue.id, issueId)
    assert.equal(issue.group_id, groupId)
    assert.equal(issue.cloud_project_id, groupId)
    if (issue.metadata.is_unread === false) {
      console.log(
        `[e2e] Viewed Issue read confirmed before draft baseline: ${issue.id}, version=${issue.version}`
      )
      return
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`The visible Issue did not persist its automatic read: ${JSON.stringify(issue)}`)
}

/** Confirm public content through the real form; private Task prompts never enter it. */
export async function confirmTaskOriginPublicThread(
  control,
  { title, description = '', groupId, groupName, unclassified = false }
) {
  if (unclassified) {
    await control.command('waitFor', '[data-testid="thread-home-project"]', { visible: true })
    assert.equal(await control.command('getValue', '[data-testid="thread-home-project"]'), '')
    await control.command('chooseWhenEnabled', '[data-testid="thread-home-store"]', {
      value: 'local',
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
    await control.command('clickWhenEnabled', '[data-testid="thread-home-create"]')
  }
  const dialog = await prepareGroupThreadCreation(control, {
    groupId,
    groupName,
    contentSelector: 'body',
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const descriptionField = `${dialog} [data-testid="cloud-todo-detail-description"]`
  assert.equal(
    await control.command('getValue', descriptionField),
    '',
    'Private Task content leaked into the public form'
  )
  await control.command('fill', `${dialog} [data-testid="cloud-todo-title"]`, { value: title })
  await control.command('fill', descriptionField, { value: description })
  await captureVerificationScreenshot(control, 'task-origin-public-content-review.png')
  await control.command('clickWhenEnabled', `${dialog} [data-testid="cloud-todo-create-confirm"]`, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', dialog, { visible: false, timeoutMs: DEFAULT_STEP_TIMEOUT_MS })
  const catalog = await requestExecutor(control, 'chat_groups.list', {}, DEFAULT_STEP_TIMEOUT_MS)
  const group = catalog.items.find(value =>
    groupId ? value.id === groupId : value.name === groupName
  )
  assert.ok(group, 'The public form did not create or select the exact group')
  const items = await requestExecutor(
    control,
    'todos.list',
    { project_id: group.id },
    DEFAULT_STEP_TIMEOUT_MS
  )
  const item = items.find(value => value.title === title)
  assert.ok(item, 'The confirmed public Thread is missing from its actual group')
  assert.equal(item.group_id, group.id)
  assert.equal(item.cloud_project_id, group.id)
  assert.equal(item.description, description)
  const projectLink = await requestExecutor(
    control,
    'chat_groups.project_link.get',
    { thread_id: item.id },
    DEFAULT_STEP_TIMEOUT_MS
  )
  if (unclassified) assert.equal(projectLink.project, null)
  return { group, item, projectLink }
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
  const chooseProject = async (verifyLayout = false, target = project) => {
    const projectPicker = `${content} button[data-testid="project-space-context-pill"]`
    await control.command('waitFor', projectPicker, { visible: true })
    await control.command('click', projectPicker)
    await control.command(
      'markElementWithText',
      '[data-testid="work-item-context-menu"] [data-testid^="work-item-workspace-option-"]',
      { text: target.name, value: 'draft-target-project', timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    if (verifyLayout) {
      await control.command('startElementMetricsSampling', 'body', {
        value: String(DEFAULT_STEP_TIMEOUT_MS),
        target: ['dialog', 'search', 'create']
          .map(id => `[data-testid="task-board-association-${id}"]`)
          .join(', '),
      })
    }
    await control.command('click', '[data-e2e-anchor-id="draft-target-project"]')
    await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
      text: target.name,
      visible: true,
    })
    if (verifyLayout) await verifyAssociationDialogLayout(control, existingItem)
  }
  await control.command('waitFor', composer, { visible: true })
  let selectedItem = existingItem
  let selectedOwner = project
  if (existingItem) {
    const { group } = await rpc('chat_groups.get', { group_id: existingItem.group_id })
    selectedOwner = group
    await chooseProject(true, group)
  }
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
  if (existingItem) {
    await control.command('click', `[data-testid="task-board-association-item-${existingItem.id}"]`)
    await control.command('waitFor', '[data-testid="task-origin-join-confirm"]', { visible: true })
    const beforeJoin = await rpc('chat_groups.participation.get', { thread_id: existingItem.id })
    assert.equal(
      beforeJoin.joined,
      false,
      'Browsing an unjoined Thread must not subscribe the user'
    )
    await captureVerificationScreenshot(control, 'task-origin-explicit-join-and-link.png')
    await control.command('click', '[data-testid="task-origin-join-cancel"]')
    assert.equal(
      (await rpc('chat_groups.participation.get', { thread_id: existingItem.id })).joined,
      false
    )
    await control.command('click', `[data-testid="task-board-association-item-${existingItem.id}"]`)
    await control.command('clickWhenEnabled', '[data-testid="task-origin-join-confirm"]')
    await control.command('waitFor', '[data-testid="task-origin-join-dialog"]', { visible: false })
    assert.equal(
      (await rpc('chat_groups.participation.get', { thread_id: existingItem.id })).joined,
      true
    )
  } else {
    await control.command('click', `${content} [data-testid="project-space-context-pill"]`)
    await control.command('click', '[data-testid="task-origin-new-thread"]')
    const created = await confirmTaskOriginPublicThread(control, {
      title: 'CREATE_NEW_DRAFT: Reviewed public Thread',
      description: 'Explicitly reviewed shared scope',
      groupName: `Standalone task draft ${tabId}`,
      unclassified: true,
    })
    selectedItem = created.item
    selectedOwner = created.group
    assert.equal((await rpc('todos.bindings', { task_id: selectedItem.id })).length, 0)
  }
  await control.command('waitFor', '[data-testid="task-board-association-dialog"]', {
    visible: false,
  })
  const selectedBaseline = await rpc('todos.list', { project_id: project.id })
  assert.equal(selectedBaseline.length, beforeItems.length)
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
    selectedBaseline,
    'Draft selection or cancellation changed board cards before submission'
  )
  await selectE2EModel(control)
  control.setScenario('checkpoint_task')
  const marker = existingItem ? 'LINK_EXISTING_DRAFT' : 'CREATE_NEW_DRAFT'
  const prompt = `${marker}: ${CHECKPOINT_TASK_PROMPT}`
  await sendPromptUntilScenarioRequest(control, composer, prompt, 'checkpoint_task')
  const binding = await waitForBinding(control, selectedOwner.id, selectedItem.id)
  await verifyIssueRuntimeReply(control, content, binding)
  const persisted = await rpc('todos.get', {
    project_id: selectedOwner.id,
    task_id: binding.loop_item_id,
  })
  const afterItems = await rpc('todos.list', { project_id: project.id })
  assert.equal(
    afterItems.length,
    beforeItems.length,
    'Private submission must not create another public card'
  )
  assert.equal(persisted.id, selectedItem.id)
  assert.equal(persisted.group_id, selectedOwner.id)
  assert.equal(persisted.cloud_project_id, selectedOwner.id)
  assert.equal(persisted.title, selectedItem.title)
  assert.equal(persisted.description, selectedItem.description)
  assert.notEqual(
    persisted.description,
    prompt,
    'The private first prompt became shared description'
  )
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
  await verifyIssueRuntimeTitleIsolation(control, content, selectedOwner, persisted, binding)
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
  assert.ok(existingItem.group_id, 'The existing Thread must belong to a real group')
  assert.equal(existingItem.cloud_project_id, existingItem.group_id)
  await verifyDraft(control, project, null)
  const layoutFixtures = []
  try {
    for (let index = 0; index < 12; index += 1) {
      layoutFixtures.push(
        await requestExecutor(
          control,
          'todos.create',
          {
            project_id: existingItem.group_id,
            todo: {
              title: `Association layout fixture ${index}`,
              status: 'pending',
              classification_project_id: project.id,
            },
          },
          DEFAULT_STEP_TIMEOUT_MS
        )
      )
    }
    await requestExecutor(
      control,
      'chat_groups.participation.update',
      {
        thread_id: existingItem.id,
        joined: false,
      },
      DEFAULT_STEP_TIMEOUT_MS
    )
    await verifyDraft(control, project, existingItem)
  } finally {
    for (const fixture of layoutFixtures) {
      await requestExecutor(
        control,
        'todos.update',
        {
          project_id: existingItem.group_id,
          task_id: fixture.id,
          todo: { version: fixture.version, status: 'completed' },
        },
        DEFAULT_STEP_TIMEOUT_MS
      )
      await requestExecutor(
        control,
        'todos.archive',
        { project_id: existingItem.group_id, task_id: fixture.id },
        DEFAULT_STEP_TIMEOUT_MS
      )
    }
  }
}
