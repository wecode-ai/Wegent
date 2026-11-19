import assert from 'node:assert/strict'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForBoardValue } from './collaboration-board-flows.mjs'

async function openProjectTags(control, find) {
  const toggle = find('cloud-project-manage-tags-toggle')
  await control.command('waitFor', toggle, { visible: true })
  if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) === 'false') {
    await control.command('clickWhenEnabled', toggle)
  }
  await control.command('waitFor', `${toggle}[aria-expanded="true"]`, { visible: true })
}

// Reuse shared-core's real project and backend; this flow never saves the environment draft.
export async function verifyCollaborationSettingsUx(control, { scoped, request, project }) {
  const find = id => scoped(`[data-testid="${id}"]`)
  const environment = 'collaboration-project-execution-environment'
  const persisted = await request(`/api/v1/cloud-projects/${project.id}`)
  await selectCollaborationProjectView(control, scoped('').trim(), 'manage')
  await control.command('click', find('collaboration-project-settings-project'))
  await control.command('waitFor', find('cloud-project-manage-visibility-private'))
  for (const visibility of ['private', 'public']) {
    assert.equal(
      await control.command('getAttribute', find(`cloud-project-manage-visibility-${visibility}`), {
        value: 'aria-pressed',
      }),
      String((persisted.visibility ?? 'private') === visibility)
    )
  }
  await openProjectTags(control, find)
  await control.command('clickWhenEnabled', find('cloud-project-tag-create-toggle'))
  await control.command(
    'waitFor',
    scoped('label:has([data-testid="cloud-project-tag-create-input"])'),
    { text: '标签名称' }
  )

  await control.command('click', find('collaboration-project-settings-environments'))
  await control.command('click', find(`${environment}-preparation-toggle`))
  await control.command('click', find(`${environment}-add-repository`))
  await control.command('fill', find(`${environment}-repository-url-0`), {
    value: 'https://example.com/settings-draft.git',
  })
  await control.command('click', find(`${environment}-add-setup-step`))
  await control.command('fill', find(`${environment}-setup-command-0`), {
    value: 'pnpm install --frozen-lockfile',
  })
  await control.command('click', find('collaboration-project-settings-members'))
  await control.command('waitFor', find('cloud-project-members-panel'), { visible: true })
  await control.command('click', find('collaboration-project-settings-environments'))
  await waitForBoardValue(
    async () => {
      const metrics = JSON.parse(
        await control.command('getElementMetrics', find(`${environment}-setup-command-0`), {
          value: JSON.stringify({ attributeNames: ['data-testid'] }),
        })
      )
      return metrics[0]?.rendered ?? false
    },
    true,
    'Returning to settings must render the retained environment draft',
    DEFAULT_STEP_TIMEOUT_MS
  )
  await control.command('scrollIntoView', find(`${environment}-setup-command-0`))
  await control.command('waitFor', find(`${environment}-setup-command-0`), { visible: true })
  assert.equal(
    await control.command('getValue', find(`${environment}-repository-url-0`)),
    'https://example.com/settings-draft.git'
  )
  assert.equal(
    await control.command('getValue', find(`${environment}-setup-command-0`)),
    'pnpm install --frozen-lockfile'
  )
  const unchanged = await request(`/api/v1/cloud-projects/${project.id}`)
  assert.deepEqual(
    unchanged.execution_environment?.repositories,
    persisted.execution_environment?.repositories
  )
  assert.deepEqual(
    unchanged.execution_environment?.setup_steps,
    persisted.execution_environment?.setup_steps
  )

  await control.command('click', find('collaboration-project-settings-sharing'))
  await control.command('clickWhenEnabled', find('project-template-import'))
  const templateDialog = '[data-testid="collaboration-template-dialog"][role="dialog"][data-open]'
  await control.command('waitFor', templateDialog, { visible: true })
  await control.command('clickWhenEnabled', find('template-details-product-lifecycle'))
  await control.command('waitFor', `${templateDialog} [data-testid="template-inline-detail"]`, {
    visible: true,
  })
  assert.equal(
    Number(await control.command('getElementCount', '[role="dialog"][data-open]')),
    1,
    'Template details must reuse the existing dialog'
  )
  await control.command('click', find('template-detail-cancel'))
  await control.command('waitFor', find('template-search'), { visible: true })
  await control.command('click', find('collaboration-template-close'))
  await selectCollaborationProjectView(control, scoped('').trim(), 'board')
}

async function addProjectTag(control, scoped, tag) {
  const find = id => scoped(`[data-testid="${id}"]`)
  await control.command('click', find('collaboration-project-settings-project'))
  await openProjectTags(control, find)
  await control.command('clickWhenEnabled', find('cloud-project-tag-create-toggle'))
  await control.command('fill', find('cloud-project-tag-create-input'), { value: tag })
  await control.command('clickWhenEnabled', find('cloud-project-tag-create-confirm'))
  await control.command('waitFor', find(`cloud-project-tag-${tag}`), { visible: true })
}

async function assertKeyboardFocus(control, id) {
  await waitForBoardValue(
    () => control.command('getActiveElementTestId', 'body'),
    id,
    'Dialog keyboard focus must remain on ' + id,
    DEFAULT_STEP_TIMEOUT_MS
  )
}

async function verifyAgentDialogKeyboard(control, scoped) {
  const find = id => scoped('[data-testid="' + id + '"]')
  await control.command('click', find('collaboration-project-settings-agents'))
  const ids = JSON.parse(await control.command('snapshot', scoped('').trim())).testIds
  const editId = ids.find(id => id.startsWith('project-agent-edit-'))
  assert.ok(editId, 'The scenario must have an editable project Agent')
  await control.command('focusMainWindow', 'body')
  await control.command('nativePress', find(editId), { key: 'Enter' })
  const editor = '[data-testid="cloud-project-chat-agent-editor"][role="dialog"]'
  await control.command('waitFor', editor, { visible: true })
  const save = `${editor} [data-testid="cloud-project-chat-agent-save"]`
  await control.command('waitFor', save + ':not(:disabled)', { visible: true })
  await control.command('nativePress', save, { key: 'Tab' })
  await assertKeyboardFocus(control, 'cloud-project-chat-agent-cancel')
  await control.command(
    'nativePress',
    `${editor} [data-testid="cloud-project-chat-agent-cancel"]`,
    {
      key: 'Escape',
    }
  )
  await control.command('waitFor', editor, { visible: false })
  await assertKeyboardFocus(control, editId)
}

async function createDisabledSchedule(control, scoped) {
  const find = id => scoped(`[data-testid="${id}"]`)
  await control.command('clickWhenEnabled', find('automatic-processing-create'))
  await control.command('click', find('automatic-processing-trigger-schedule'))
  await control.command('fill', find('automatic-processing-prompt'), {
    value: 'Settings version regression; never enable this rule.',
  })
  if (
    Number(
      await control.command('getElementCount', `${find('automatic-processing-enabled')}:checked`)
    ) > 0
  )
    await control.command('click', find('automatic-processing-enabled'))
  await control.command('click', find('automatic-processing-target'))
  await control.command('waitFor', find('automatic-processing-target-search'), { visible: true })
  const options = find('automatic-processing-target-picker') + ' [role="option"]'
  assert.ok(
    Number(await control.command('getElementCount', options)) >= 2,
    'The local fixture must provide multiple Agent targets'
  )
  const first = await control.command('getAttribute', options + ':first-child', {
    value: 'data-testid',
  })
  const second = await control.command('getAttribute', options + ':nth-child(2)', {
    value: 'data-testid',
  })
  await control.command('nativePress', find('automatic-processing-target-search'), {
    key: 'ArrowDown',
  })
  await assertKeyboardFocus(control, first)
  await control.command('nativePress', find(first), { key: 'ArrowDown' })
  await assertKeyboardFocus(control, second)
  await control.command('nativePress', find(second), { key: 'ArrowUp' })
  await assertKeyboardFocus(control, first)
  await control.command('nativePress', find(first), { key: 'Escape' })
  await assertKeyboardFocus(control, 'automatic-processing-target')
  await control.command('click', find('automatic-processing-cron-advanced-toggle'))
  const validCron = await control.command('getValue', find('automatic-processing-cron'))
  await control.command('fill', find('automatic-processing-cron'), { value: 'invalid' })
  await control.command('clickWhenEnabled', find('automatic-processing-save'))
  await control.command('waitFor', scoped('#automatic-processing-cron-error'), {
    text: 'Cron 表达式无效',
    visible: true,
  })
  await assertKeyboardFocus(control, 'automatic-processing-cron')
  assert.equal(
    await control.command('getAttribute', find('automatic-processing-cron'), {
      value: 'aria-invalid',
    }),
    'true'
  )
  assert.equal(await control.command('getValue', find('automatic-processing-cron')), 'invalid')
  await control.command('fill', find('automatic-processing-cron'), { value: validCron })
  await control.command('waitFor', find('automatic-processing-save') + ':not(:disabled)', {
    visible: true,
  })
  await control.command('nativePress', find('automatic-processing-save'), { key: 'Tab' })
  await assertKeyboardFocus(control, 'automatic-processing-close')
  await control.command('nativePress', find('automatic-processing-close'), { key: 'Shift+Tab' })
  await assertKeyboardFocus(control, 'automatic-processing-save')
  await control.command('clickWhenEnabled', find('automatic-processing-save'))
  await control.command('waitFor', find('automatic-processing-form'), { visible: false })
}

async function verifyGroupInlineMaintenance(control, scoped) {
  const find = id => scoped('[data-testid="' + id + '"]')
  await control.command('click', find('collaboration-project-settings-groups'))
  const rules = find('collaboration-group-detail-tab-rules')
  await control.command('waitFor', rules, { visible: true })
  if ((await control.command('getAttribute', rules, { value: 'aria-expanded' })) !== 'true')
    await control.command('click', rules)
  const members = find('collaboration-group-detail-tab-members')
  if ((await control.command('getAttribute', members, { value: 'aria-expanded' })) !== 'true')
    await control.command('click', members)
  assert.equal(await control.command('getAttribute', rules, { value: 'aria-expanded' }), 'true')
  assert.equal(await control.command('getAttribute', members, { value: 'aria-expanded' }), 'true')
  const instructions = find('collaboration-group-detail-instructions')
  const original = await control.command('getValue', instructions)
  const draft = original + '\nUnsaved inline configuration regression.'
  await control.command('fill', instructions, { value: draft })
  await control.command('waitFor', find('collaboration-group-save-status'), {
    text: '有未保存的更改',
  })
  await control.command('click', find('collaboration-project-settings-members'))
  await control.command('waitFor', find('cloud-project-members-panel'), { visible: true })
  await control.command('click', find('collaboration-project-settings-groups'))
  assert.equal(await control.command('getValue', instructions), draft)
  await control.command('click', find('collaboration-group-detail-tab-sharing'))
  await control.command('waitFor', find('group-template-saved-version-hint'), {
    text: '上次保存的版本',
  })
  await control.command('click', find('collaboration-group-detail-back'))
  await control.command('waitFor', find('collaboration-group-unsaved-dialog'), { visible: true })
  await control.command('click', find('collaboration-group-unsaved-cancel'))
  assert.equal(await control.command('getValue', instructions), draft)
  await control.command('clickWhenEnabled', find('collaboration-group-detail-discard'))
  assert.equal(await control.command('getValue', instructions), original)
  await control.command('waitFor', find('collaboration-group-save-status'), { text: '配置已保存' })
  const detailId = await control.command(
    'getAttribute',
    scoped('[data-testid^="collaboration-group-detail-"]:has(> form)'),
    { value: 'data-testid' }
  )
  const groupId = detailId.slice('collaboration-group-detail-'.length)
  assert.ok(groupId)
  await control.command('click', find('collaboration-group-detail-back'))
  await control.command('nativePress', find('collaboration-group-open-create'), { key: 'Enter' })
  await control.command('waitFor', find('collaboration-group-form'), { visible: true })
  await control.command('nativePress', find('collaboration-group-create-cancel'), { key: 'Tab' })
  await assertKeyboardFocus(control, 'collaboration-group-create-close')
  await control.command('nativePress', find('collaboration-group-create-close'), { key: 'Escape' })
  await control.command('waitFor', find('collaboration-group-form'), { visible: false })
  await assertKeyboardFocus(control, 'collaboration-group-open-create')
  await control.command('click', find('collaboration-group-manage-' + groupId))
}

async function verifyNarrowSettingsNavigation(control, scoped, projectId) {
  const find = id => scoped(`[data-testid="${id}"]`)
  const original = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 560, height: 740 }),
  })
  try {
    const toggle = find('collaboration-settings-navigation-toggle')
    await control.command('waitFor', toggle, { visible: true })
    assert.equal(await control.command('getAttribute', toggle, { value: 'aria-expanded' }), 'false')
    const [sidebar] = JSON.parse(
      await control.command('getElementMetrics', find('collaboration-platform-sidebar'))
    )
    assert.ok(sidebar.height <= 64, 'Collapsed navigation must leave room for project maintenance')
    await control.command('click', toggle)
    assert.equal(await control.command('getAttribute', toggle, { value: 'aria-expanded' }), 'true')
    const sidebarClass = await control.command(
      'getAttribute',
      find('collaboration-platform-sidebar'),
      { value: 'class' }
    )
    if (sidebarClass.includes('collaboration-platform-sidebar-full')) {
      const [content] = JSON.parse(
        await control.command('getElementMetrics', find('collaboration-navigation-content'))
      )
      assert.ok(
        content.height > content.viewportHeight / 2,
        'Expanded full navigation must use the available window height instead of retaining a half-screen settings cap'
      )
    }
    const project = find(`collaboration-workspace-project-${projectId}`)
    await control.command('scrollIntoView', project)
    await control.command('waitFor', project, { visible: true })
    await control.command('clickWhenEnabled', project)
    await selectCollaborationProjectView(control, scoped('').trim(), 'board')
  } finally {
    await control.command('setMainWindowSize', 'body', { value: original })
    const expected = JSON.parse(original)
    await waitForBoardValue(
      async () => {
        const [body] = JSON.parse(await control.command('getElementMetrics', 'body'))
        return { width: body.viewportWidth, height: body.viewportHeight }
      },
      { width: expected.width, height: expected.height },
      'The original viewport must be restored before the owning scenario continues',
      DEFAULT_STEP_TIMEOUT_MS
    )
  }
}

export async function verifyLocalSettingsProjectVersion(control, { scoped, projectName }) {
  const projects = await requestExecutor(control, 'projects.list', {}, DEFAULT_STEP_TIMEOUT_MS)
  const project = projects.find(candidate => candidate.name === projectName)
  assert.ok(project, 'The local settings regression requires its owning scenario project')
  const readVersion = async () => {
    const records = await requestExecutor(control, 'projects.list', {}, DEFAULT_STEP_TIMEOUT_MS)
    return records.find(candidate => candidate.id === project.id).version
  }
  const find = id => scoped(`[data-testid="${id}"]`)
  await selectCollaborationProjectView(control, scoped('').trim(), 'manage')
  await verifyAgentDialogKeyboard(control, scoped)
  await verifyGroupInlineMaintenance(control, scoped)
  // The owning scenario just created a group. The first tag save must use that new Project version.
  await addProjectTag(control, scoped, 'settings-group-version')
  const before = await readVersion()
  await control.command('click', find('collaboration-project-settings-automatic-processing'))
  const beforeRules = new Set(
    JSON.parse(await control.command('snapshot', scoped('').trim())).testIds
  )
  await createDisabledSchedule(control, scoped)
  const ruleId = JSON.parse(await control.command('snapshot', scoped('').trim()))
    .testIds.find(id => id.startsWith('automatic-processing-edit-') && !beforeRules.has(id))
    ?.slice('automatic-processing-edit-'.length)
  assert.ok(ruleId, 'Saving the disabled rule must render its persisted row')
  assert.ok((await readVersion()) > before, 'Local rule creation must advance Project.version')
  await addProjectTag(control, scoped, 'settings-rule-create')

  await control.command('click', find('collaboration-project-settings-automatic-processing'))
  await control.command('click', find(`automatic-processing-edit-${ruleId}`))
  await control.command('fill', find('automatic-processing-prompt'), {
    value: 'Updated disabled settings regression.',
  })
  await control.command('clickWhenEnabled', find('automatic-processing-save'))
  await control.command('waitFor', find('automatic-processing-form'), { visible: false })
  await addProjectTag(control, scoped, 'settings-rule-update')
  await control.command('click', find('collaboration-project-settings-automatic-processing'))
  await control.command('focus', find(`automatic-processing-delete-${ruleId}`))
  await control.command('clickWhenEnabled', find(`automatic-processing-delete-${ruleId}`))
  await control.command('waitFor', find('automatic-processing-delete-dialog'), { visible: true })
  const isolatedNavigation = `${find('collaboration-project-settings-project')}:is([inert], [inert] *)`
  await control.command('waitFor', isolatedNavigation)
  await control.command('click', find('automatic-processing-delete-cancel'))
  await control.command('waitFor', find('automatic-processing-delete-dialog'), { visible: false })
  assert.equal(
    Number(await control.command('getElementCount', isolatedNavigation)),
    0,
    'Cancelling the confirmation must restore background navigation'
  )
  await control.command('waitFor', `${find(`automatic-processing-delete-${ruleId}`)}:focus`)
  await control.command('waitFor', find(`automatic-processing-rule-${ruleId}`), { visible: true })
  await control.command('clickWhenEnabled', find(`automatic-processing-delete-${ruleId}`))
  await control.command('clickWhenEnabled', find('automatic-processing-delete-confirm'))
  await control.command('waitFor', find(`automatic-processing-rule-${ruleId}`), { visible: false })
  await addProjectTag(control, scoped, 'settings-rule-delete')
  await verifyNarrowSettingsNavigation(control, scoped, project.id)
}
