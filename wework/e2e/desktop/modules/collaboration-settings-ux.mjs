import assert from 'node:assert/strict'
import { selectCollaborationProjectView } from './collaboration-project-navigation.mjs'
import { requestExecutor } from './executor-rpc.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

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
  await control.command('click', `${find('cloud-project-manage-tags')} > summary`)
  await control.command('click', find('cloud-project-tag-create-toggle'))
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
  await control.command('clickWhenEnabled', find('template-details-product-lifecycle'))
  await control.command('waitFor', find('template-detail-inline'), { visible: true })
  assert.equal(
    Number(await control.command('getElementCount', scoped('dialog[open]'))),
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
  if (
    Number(
      await control.command('getElementCount', `${find('cloud-project-manage-tags')}[open]`)
    ) === 0
  )
    await control.command('click', `${find('cloud-project-manage-tags')} > summary`)
  await control.command('click', find('cloud-project-tag-create-toggle'))
  await control.command('fill', find('cloud-project-tag-create-input'), { value: tag })
  await control.command('clickWhenEnabled', find('cloud-project-tag-create-confirm'))
  await control.command('waitFor', find(`cloud-project-tag-${tag}`), { visible: true })
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
  await control.command('clickWhenEnabled', find('collaboration-group-detail-discard'))
  assert.equal(await control.command('getValue', instructions), original)
  await control.command('waitFor', find('collaboration-group-save-status'), { text: '配置已保存' })
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
  await control.command('clickWhenEnabled', find(`automatic-processing-delete-${ruleId}`))
  await control.command('waitFor', find(`automatic-processing-rule-${ruleId}`), { visible: false })
  await addProjectTag(control, scoped, 'settings-rule-delete')
  await selectCollaborationProjectView(control, scoped('').trim(), 'board')
}
