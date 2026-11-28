import { openProjectScopeDetails } from './stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import { openStandInSettings } from './stand-in-profile-navigation.mjs'
import { openConnectionTypePicker } from './stand-in-flows.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'

const id = testId => `[data-testid="${testId}"]`
const dingtalk = name => id(`stand-in-dingtalk-${name}`)
const provider = '@wegent/dsh-connection-dingtalk/dingtalk'
const selectedSources = primary =>
  primary.connections?.filter(row => row.providerId === provider) ?? []
const panel = id('stand-in-primary-profile')

async function enterSource(control, source) {
  await control.command('clickWhenEnabled', id(`stand-in-add-${source}-connection`))
}

async function openConnections(control) {
  await openStandInSettings(control)
  await control.command('clickWhenEnabled', id('stand-in-primary-connections-open'))
  await openConnectionTypePicker(control)
}

async function choose(control, name, value) {
  await control.command('clickWhenEnabled', id(name))
  await control.command('clickWhenEnabled', id(`${name}-${value}`))
}

async function saveScope(control, list) {
  await control.command('clickWhenEnabled', id('stand-in-primary-save'))
  await control.command('waitFor', id('stand-in-path-scope'), { visible: false })
  await control.command('waitFor', list)
}

async function save(control) {
  const scope = id('stand-in-path-scope')
  const fromScope = (await control.command('getElementCount', scope)) !== '0'
  if (fromScope) {
    await saveScope(control, dingtalk('add-scope'))
    await control.command('clickWhenEnabled', id('stand-in-primary-profile-close'))
  } else await control.command('clickWhenEnabled', id('stand-in-primary-save'))
  await control.command('waitFor', panel, { visible: false })
}

async function verifyScheduleEditor(control, userId, options) {
  const rpc = (method, params) => requestExecutor(control, method, params, options.uiTimeoutMs)
  const name = 'Review open project work'
  const initial = await rpc('runtime.stand_in.personal.get', { userId })
  const paused = await rpc('runtime.stand_in.personal.save', {
    userId,
    settings: {
      ...initial,
      primary: {
        ...initial.primary,
        calendar: { policy: { automatic: false, askBeforeAct: false } },
      },
    },
  })
  assert.equal(paused.primary.calendar.policy.automatic, false)
  await reloadMainWindow(control, 'The assistant should read the paused legacy schedule policy')
  await control.command('clickWhenEnabled', id('personal-stand-in-button'))
  await control.command('clickWhenEnabled', id('stand-in-primary-open'))
  let schedule
  try {
    await openConnections(control)
    await control.command('clickWhenEnabled', id('stand-in-time-connections'))
    await control.command('waitFor', id('stand-in-calendar-connection'))
    const resume = id('stand-in-calendar-resume')
    await control.command('waitFor', resume)
    await options.captureScreenshot(control, 'connection-calendar-paused.png', panel)
    await control.command('clickWhenEnabled', resume)
    await control.command('clickWhenEnabled', id('stand-in-calendar-policy-ask-before-act'))
    const pending = (await rpc('runtime.stand_in.personal.get', { userId })).primary.calendar.policy
    assert.equal(pending.automatic, false, 'Resuming scheduled work stays in the draft until save')
    await save(control)
    const saved = (await rpc('runtime.stand_in.personal.get', { userId })).primary.calendar.policy
    assert.equal(saved.automatic, true)
    assert.equal(saved.askBeforeAct, true)
    await openConnections(control)
    await control.command('clickWhenEnabled', id('stand-in-time-connections'))
    await control.command('waitFor', resume, { visible: false })
    await options.captureScreenshot(control, 'connection-calendar-list.png', panel)
    await control.command('clickWhenEnabled', id('create-automation-button'))
    await control.command('fill', id('automation-name-input'), { value: name })
    await control.command('fill', id('automation-prompt-input'), {
      value: 'Summarize outstanding project work.',
    })
    await control.command('clickWhenEnabled', id('automation-repeat-menu'))
    await control.command('clickWhenEnabled', id('automation-repeat-menu-option-one_time'))
    await control.command('waitFor', id('automation-execute-at-input'))
    const executeAt = await control.command('getValue', id('automation-execute-at-input'))
    await control.command('waitFor', id('stand-in-primary-save'), { visible: false })
    await options.captureScreenshot(control, 'connection-calendar-create.png', panel)
    await control.command('clickWhenEnabled', id('automation-save-button'))
    await control.command('waitFor', id('automation-list-pane'), { text: name })
    schedule = (await rpc('runtime.automations.list', {})).items.find(item => item.name === name)
    assert.ok(schedule, 'Saving the schedule must persist a real automation')
    assert.deepEqual(schedule.taskRequest.standInOwner, { userId, roleId: '@primary' })
    assert.equal(schedule.schedule.type, 'one_time')
    assert.equal(Date.parse(schedule.schedule.execute_at), Date.parse(executeAt))
    const item = id(`automation-open-${schedule.id}`)
    await control.command('clickWhenEnabled', item)
    await control.command('waitFor', id('automation-prompt-input'))
    await control.command('waitFor', id('stand-in-primary-save'), { visible: false })
    assert.equal(await control.command('getValue', id('automation-execute-at-input')), executeAt)
    await options.captureScreenshot(control, 'connection-calendar-reopened.png', panel)
    await control.command('waitFor', id('stand-in-path-scope'), { text: '定时安排' })
    await control.command('clickWhenEnabled', id('stand-in-connections-back'))
    await control.command('waitFor', id('automation-list-pane'), { text: name })
    await control.command('waitFor', id('stand-in-path-scope'), { visible: false })

    const updatedName = 'Review outstanding project work'
    await control.command('clickWhenEnabled', item)
    await control.command('fill', id('automation-name-input'), { value: updatedName })
    await control.command('clickWhenEnabled', id('automation-save-button'))
    await control.command('waitFor', item, { text: updatedName })
    const getSchedule = async () =>
      (await rpc('runtime.automations.get', { automationId: schedule.id })).automation
    const updated = await getSchedule()
    assert.equal(updated.name, updatedName)
    assert.deepEqual(updated.schedule, schedule.schedule)
    assert.deepEqual(updated.taskRequest.standInOwner, schedule.taskRequest.standInOwner)
    await options.captureScreenshot(control, 'connection-calendar-updated.png', panel)

    await control.command('clickWhenEnabled', item)
    const confirmDeletion = async () => {
      await control.command('clickWhenEnabled', id(`automation-detail-actions-${schedule.id}`))
      await control.command('clickWhenEnabled', id('automation-detail-delete'))
      await control.command('waitFor', id('confirmation-request-dialog'), {
        text: `删除定时安排「${updatedName}」？`,
      })
    }
    await confirmDeletion()
    await options.captureScreenshot(control, 'connection-calendar-delete-confirmation.png')
    await control.command('clickWhenEnabled', id('confirmation-request-cancel'))
    await control.command('waitFor', id('confirmation-request-dialog'), { visible: false })
    assert.equal((await getSchedule()).name, updatedName)
    await confirmDeletion()
    await control.command('clickWhenEnabled', id('confirmation-request-confirm'))
    await control.command('waitFor', id('automation-detail-panel'), { visible: false })
    await control.command('waitFor', item, { visible: false })
    assert.ok(
      !(await rpc('runtime.automations.list', {})).items.some(row => row.id === schedule.id)
    )
    schedule = undefined
    await options.captureScreenshot(control, 'connection-calendar-deleted.png', panel)
    await control.command('clickWhenEnabled', id('stand-in-primary-cancel'))
  } finally {
    if (schedule) await rpc('runtime.automations.delete', { automationId: schedule.id })
  }
}

export async function verifyPrimaryDingTalkConnections(control, userId, fixture, options) {
  const { uiTimeoutMs, captureScreenshot, project, secondProject } = options
  const load = () =>
    requestExecutor(control, 'runtime.stand_in.personal.get', { userId }, uiTimeoutMs)
  await fixture.setAuthState('scoped-ready')
  await control.command('clickWhenEnabled', id('stand-in-primary-open'))
  await openConnections(control)

  await enterSource(control, 'projects')
  await openProjectScopeDetails(control)
  await control.command('waitFor', id('stand-in-path-scope'), { text: '项目和独立事项' })
  await control.command('clickWhenEnabled', id('stand-in-independent-issues'))
  await control.command('waitFor', `${id('stand-in-independent-issues')}[aria-checked="true"]`)
  await captureScreenshot(control, 'connection-projects-add-scope.png', panel)
  const projectList = id('stand-in-project-add-scope')
  await saveScope(control, projectList)
  await control.command('waitFor', id('stand-in-project-open-scope-includeIndependentIssues'))
  await control.command('waitFor', id('stand-in-project-open-scope-projects'), { visible: false })
  await control.command(
    'clickWhenEnabled',
    id('stand-in-project-open-scope-includeIndependentIssues')
  )
  await control.command('waitFor', id('stand-in-path-scope'), { text: '独立事项' })
  await control.command('clickWhenEnabled', id('stand-in-source-tags-toggle'))
  await control.command('fill', id('stand-in-connection-tags-input'), { value: 'independent-qa' })
  await control.command('press', id('stand-in-connection-tags-input'), { key: 'Enter' })
  await control.command('waitFor', id('stand-in-connection-tags-tag-independent-qa'))
  await saveScope(control, projectList)
  await openProjectScopeDetails(control)
  await control.command('waitFor', `${id('stand-in-independent-issues')}[aria-checked="true"]`)
  await control.command('fill', id('stand-in-search-project-scope'), { value: project.name })
  const selectedProject = id(`stand-in-connect-project-${project.id}`)
  await control.command('clickWhenEnabled', selectedProject)
  await control.command('waitFor', `${selectedProject}[aria-checked="true"]`)
  const tagToggle = id('stand-in-source-tags-toggle')
  if ((await control.command('getAttribute', tagToggle, { value: 'aria-expanded' })) === 'false') {
    await control.command('clickWhenEnabled', tagToggle)
  }
  await control.command('waitFor', id('stand-in-project-tag-scope'), { text: project.name })
  await control.command('waitFor', id('stand-in-connection-tags-tag-independent-qa'), {
    visible: false,
  })
  await control.command('fill', id('stand-in-connection-tags-input'), { value: 'project-qa' })
  await control.command('press', id('stand-in-connection-tags-input'), { key: 'Enter' })
  await control.command('waitFor', id('stand-in-connection-tags-tag-project-qa'))
  await captureScreenshot(control, 'connection-projects-specific-project.png', panel)
  await control.command('fill', id('stand-in-search-project-scope'), { value: secondProject.name })
  const secondSelection = id(`stand-in-connect-project-${secondProject.id}`)
  await control.command('clickWhenEnabled', secondSelection)
  await control.command('waitFor', `${secondSelection}[aria-checked="true"]`)
  await choose(control, 'stand-in-project-tag-scope', `local:${secondProject.id}`)
  await control.command('waitFor', id('stand-in-project-tag-scope'), { text: secondProject.name })
  await control.command('waitFor', id('stand-in-connection-tags-tag-project-qa'), {
    visible: false,
  })
  await control.command('fill', id('stand-in-connection-tags-input'), {
    value: 'second-project-qa',
  })
  await control.command('press', id('stand-in-connection-tags-input'), { key: 'Enter' })
  await control.command('waitFor', id('stand-in-connection-tags-tag-second-project-qa'))
  await captureScreenshot(control, 'connection-projects-second-project-tags.png', panel)
  await saveScope(control, projectList)
  await control.command('clickWhenEnabled', id('stand-in-project-add-scope'))
  await control.command('clickWhenEnabled', id('stand-in-participating-issues'))
  await choose(control, 'stand-in-project-participatingTrigger', 'assignment')
  await saveScope(control, projectList)
  await captureScreenshot(control, 'connection-projects-custom-issue-triggers.png', panel)
  await control.command('clickWhenEnabled', id('stand-in-connections-back'))

  await enterSource(control, 'dingtalk')
  await control.command('waitFor', dingtalk('connections'))
  const beforeGroup = (await load()).primary
  await control.command('clickWhenEnabled', dingtalk('add-scope'))
  await captureScreenshot(control, 'connection-dingtalk-choose-scope.png', panel)
  await control.command('clickWhenEnabled', dingtalk('kind-group'))
  await control.command('clickWhenEnabled', dingtalk('choose-all'))
  await control.command('waitFor', id('stand-in-primary-save'), {
    text: '保存接收范围',
    enabled: true,
  })
  await control.command('waitFor', id('stand-in-primary-cancel'), { text: '放弃', enabled: true })
  await captureScreenshot(control, 'connection-dingtalk-all-groups-before-discard.png', panel)
  await control.command('clickWhenEnabled', id('stand-in-connections-back'))
  await control.command('waitFor', dingtalk('add-scope'))
  await control.command('waitFor', dingtalk('open-scope-group-*'), { visible: false })
  assert.deepEqual((await load()).primary, beforeGroup, 'Back discards the new all-groups scope')
  await control.command('clickWhenEnabled', dingtalk('add-scope'))
  await control.command('clickWhenEnabled', dingtalk('kind-group'))
  await control.command('waitFor', dingtalk('query'), { visible: false })
  await control.command('clickWhenEnabled', dingtalk('choose-selected'))
  await control.command('fill', dingtalk('query'), { value: 'Scoped Group' })
  await control.command('clickWhenEnabled', dingtalk('search'))
  await control.command('clickWhenEnabled', dingtalk('result-scoped-group'))
  await choose(control, 'stand-in-dingtalk-message-scope-scoped-group', 'mentions')
  await captureScreenshot(control, 'connection-dingtalk-custom-group-trigger.png', panel)
  assert.deepEqual((await load()).primary, beforeGroup, 'Choosing a group keeps it uncommitted')
  await saveScope(control, dingtalk('add-scope'))
  const savedGroup = dingtalk('open-scope-group-scoped-group')
  await control.command('waitFor', savedGroup)
  await control.command('clickWhenEnabled', dingtalk('add-scope'))
  await control.command('clickWhenEnabled', dingtalk('kind-direct'))
  await control.command('clickWhenEnabled', dingtalk('choose-all'))
  await saveScope(control, dingtalk('add-scope'))
  await control.command('waitFor', dingtalk('open-scope-direct-*'))
  await captureScreenshot(control, 'connection-dingtalk-group-and-all-private.png', panel)
  const beforeRemoval = (await load()).primary
  await control.command('clickWhenEnabled', dingtalk('open-scope-group-scoped-group-remove'))
  await control.command('waitFor', dingtalk('open-scope-group-scoped-group-pending-removal'), {
    text: '待移除',
  })
  assert.deepEqual((await load()).primary, beforeRemoval, 'Remove waits for explicit Save')
  await control.command('clickWhenEnabled', dingtalk('open-scope-group-scoped-group-undo-remove'))
  await control.command('waitFor', savedGroup)
  await control.command('clickWhenEnabled', dingtalk('open-scope-group-scoped-group-remove'))
  await save(control)
  const privateOnly = (await load()).primary
  assert.equal(privateOnly.dingTalkConnectionMode, 'confirmed')
  assert.equal(privateOnly.delegation, undefined)
  assert.equal(privateOnly.collaboration.participatingTrigger, 'assignment')
  assert.equal(privateOnly.collaboration.includeIndependentIssues, true)
  assert.equal(privateOnly.collaboration.allProjects, false)
  assert.deepEqual(privateOnly.collaboration.tagFilters, { independent: ['independent-qa'] })
  assert.deepEqual(privateOnly.collaboration.projectTagFilters, [
    { id: project.id, store: 'local', tags: ['project-qa'] },
    { id: secondProject.id, store: 'local', tags: ['second-project-qa'] },
  ])
  assert.deepEqual(privateOnly.collaboration.projects, [
    { id: project.id, store: 'local' },
    { id: secondProject.id, store: 'local' },
  ])
  assert.deepEqual(
    selectedSources(privateOnly).map(row => [row.kind, row.id, row.scope]),
    [['direct', '*', 'all']]
  )

  await openConnections(control)
  await enterSource(control, 'projects')
  await control.command('clickWhenEnabled', id('stand-in-project-open-scope-projects'))
  await control.command('waitFor', id('stand-in-connection-tags-tag-project-qa'))
  await choose(control, 'stand-in-project-tag-scope', `local:${secondProject.id}`)
  await control.command('waitFor', id('stand-in-connection-tags-tag-second-project-qa'))
  await control.command('waitFor', id('stand-in-connection-tags-tag-project-qa'), {
    visible: false,
  })
  await captureScreenshot(control, 'connection-projects-saved-tag-filter.png', panel)
  await control.command('clickWhenEnabled', id('stand-in-connections-back'))
  await control.command('clickWhenEnabled', id('stand-in-connections-back'))
  await enterSource(control, 'dingtalk')
  await control.command('waitFor', dingtalk('open-scope-direct-*'))
  await captureScreenshot(control, 'connection-dingtalk-all-private-messages.png', panel)
  await control.command('clickWhenEnabled', dingtalk('add-scope'))
  await control.command('clickWhenEnabled', dingtalk('scope-all'))
  await control.command('waitFor', id('stand-in-path-scope'), { text: '全部消息' })
  await captureScreenshot(control, 'connection-dingtalk-all-messages.png', panel)
  await save(control)
  const all = selectedSources((await load()).primary)
  assert.deepEqual(all.map(row => [row.kind, row.id, row.scope, row.policy.askBeforeAct]).sort(), [
    ['direct', '*', 'all', true],
    ['group', '*', 'all', true],
  ])
  assert.equal(all.find(row => row.kind === 'group').collectionKey, 'all-messages')
  assert.equal(new Set(all.map(row => row.profile)).size, 1)

  await openConnections(control)
  await enterSource(control, 'dingtalk')
  await control.command('waitFor', dingtalk('open-all-scope'))
  await captureScreenshot(control, 'connection-dingtalk-saved-all-messages.png', panel)
  await control.command('clickWhenEnabled', dingtalk('open-all-scope-remove'))
  await control.command('waitFor', dingtalk('open-all-scope-pending-removal'), { text: '待移除' })
  assert.deepEqual(selectedSources((await load()).primary), all, 'Remove only changes the draft')
  await captureScreenshot(control, 'connection-dingtalk-all-messages-removed-draft.png', panel)
  await save(control)
  const afterRemove = (await load()).primary
  assert.deepEqual(selectedSources(afterRemove), [])
  assert.deepEqual(afterRemove.collaboration, privateOnly.collaboration)
  await openConnections(control)
  await enterSource(control, 'dingtalk')
  await control.command('waitFor', dingtalk('open-all-scope'), { visible: false })
  await control.command('clickWhenEnabled', dingtalk('add-scope'))
  await control.command('clickWhenEnabled', dingtalk('scope-all'))
  await save(control)
  assert.ok(!(await fixture.operations()).some(operation => ['login', 'send'].includes(operation)))
  await verifyScheduleEditor(control, userId, options)
}
