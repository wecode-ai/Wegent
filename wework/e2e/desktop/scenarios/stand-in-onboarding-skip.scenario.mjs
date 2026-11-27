import { addAllProjectScopes, openProjectScopeDetails } from '../modules/stand-in-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { openStoryPrimary } from '../modules/stand-in-source-story-evidence.mjs'
import { createLocalCollaborationProject } from '../modules/workspace-flows.mjs'
import { openExplicitModelMenu } from './stand-in-model-execution.scenario.mjs'

const USER_ID = 9001
const selector = id => `[data-testid=${JSON.stringify(id)}]`
const CHAT = selector('stand-in-conversation')
export const ONBOARDING_FIRST_MESSAGE = 'STAND_IN_ONBOARDING_FIRST_MESSAGE'
export const ONBOARDING_FOLLOWUP = 'STAND_IN_ONBOARDING_FOLLOWUP'
const reply = message => `${message}_ANSWERED`

async function selectModelOption(control, model) {
  const option = selector(
    `model-option-${JSON.stringify([model.runtime, model.provider, model.model_id])}`
  )
  if ((await control.command('getElementCount', option, { visible: true })) === '0')
    await control.command(
      'clickWhenEnabled',
      selector(`model-group-codex-provider:${model.provider}`)
    )
  await control.command('scrollIntoView', option)
  await control.command('clickWhenEnabled', option)
  const menu = selector('model-selector-menu')
  if ((await control.command('getElementCount', menu, { visible: true })) !== '0')
    await control.command('press', menu, { key: 'Escape' })
  await control.command('waitFor', menu, { visible: false })
}

async function verifyChatModel(control, rpc, message, model, timeoutMs) {
  await control.command('fill', `${CHAT} ${selector('chat-message-input')}`, { value: message })
  await control.command('clickWhenEnabled', `${CHAT} ${selector('send-message-button')}`)
  await control.command('waitFor', CHAT, { text: reply(message), timeoutMs })
  const { task } = await rpc('runtime.tasks.get', { taskId: `stand-in-chat-${USER_ID}-primary` })
  assert.equal(task.runtimeHandle.modelSelection.modelName, model.local_model_id)
  assert.ok(task.threadId, 'The assistant conversation must have a native thread')
  return task.threadId
}

async function verifyProjectMenuDismissal(control, retainedView) {
  const trigger = `${selector('stand-in-profile-panel')} ${selector('stand-in-workspace-bar')} ${selector('project-work-button')}`
  const menu = `${selector('project-work-menu')}.z-critical`
  await control.command('scrollIntoView', trigger)
  await control.command('clickWhenEnabled', trigger)
  await control.command('waitFor', `${menu} ${selector('project-search-input')}`, { visible: true })
  assert.equal(await control.command('getText', `${menu} label`), '搜索项目')
  await control.command('press', `${menu} ${selector('project-search-input')}`, { key: 'Escape' })
  await control.command('waitFor', menu, { visible: false })
  await control.command('waitFor', selector(retainedView), { visible: true })
  assert.equal(await control.command('getActiveElementTestId', 'body'), 'project-work-button')
}

/** The real onboarding record persists independently of optional source configuration. */
export function createDesktopScenario({ uiTimeoutMs, modelResponseTimeoutMs, captureScreenshot }) {
  return {
    verifiesStandInOnboarding: true,
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const projectName = '产品上线计划'
      await control.command('clickWhenEnabled', selector('workspace-tab-select-fixed-board'))
      await createLocalCollaborationProject(
        control,
        '[data-workspace-tab-content][aria-hidden="false"]',
        projectName
      )
      const project = (await rpc('projects.list', {})).find(row => row.name === projectName)
      assert.ok(project, 'The project chooser should have a real local project to select')
      await control.command('clickWhenEnabled', selector('workspace-tab-select-fixed-task'))
      await control.command('clickWhenEnabled', selector('personal-stand-in-button'))
      await control.command('waitFor', selector('stand-in-onboarding-model-help'), {
        text: '助理详情 → 管理助理 → 运行环境',
      })
      await captureScreenshot(control, 'stand-in-first-use-model-and-help.png')
      const beforeDeferring = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-close'))
      await control.command('waitFor', selector('stand-in-onboarding'), { visible: false })
      const resume = selector('stand-in-onboarding-resume')
      await control.command('waitFor', resume, { text: '继续设置', enabled: true })
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: USER_ID }),
        beforeDeferring
      )
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER_ID })).state.completed,
        false
      )
      await control.command('waitFor', CHAT, { visible: false })
      await control.command('waitFor', selector('stand-in-message-center'), { visible: false })
      await captureScreenshot(control, 'stand-in-onboarding-deferred.png')
      assert.equal(
        await control.command('getElementCount', selector('stand-in-message-center-open')),
        '0'
      )
      await control.command('clickWhenEnabled', resume)
      await control.command('waitFor', selector('stand-in-onboarding-model'))
      const catalog = (await rpc('runtime.runner.catalog', {})).models
      const defaultModel = catalog.find(
        candidate => candidate.runtime === 'codex' && candidate.is_default
      )
      assert.ok(defaultModel, 'The execution device must expose a default Codex model')
      const model = catalog.find(
        candidate =>
          candidate.runtime === 'codex' &&
          candidate.provider === defaultModel.provider &&
          candidate.model_id !== defaultModel.model_id &&
          candidate.label !== defaultModel.label
      )
      assert.ok(
        model,
        `Setup must offer a second Codex model: ${catalog
          .filter(item => item.runtime === 'codex')
          .map(item => item.model_id)
          .join(', ')}`
      )
      const before = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      await openExplicitModelMenu(
        control,
        `${selector('stand-in-onboarding-model')} ${selector('model-selector-button')}`
      )
      await captureScreenshot(control, 'stand-in-onboarding-model-picker.png')
      await selectModelOption(control, model)
      await control.command(
        'waitFor',
        `${selector('stand-in-onboarding-model')} ${selector('model-selector-button')}`,
        { text: model.label }
      )
      await captureScreenshot(control, 'stand-in-onboarding-model-selected.png')
      await control.command('waitFor', `${selector('stand-in-onboarding-complete')}:enabled`)
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
      const projects = selector('stand-in-add-projects-connection')
      const back = selector('stand-in-onboarding-connections-back')
      await control.command('clickWhenEnabled', projects)
      await captureScreenshot(control, 'stand-in-onboarding-projects-receive-scope.png')
      await openProjectScopeDetails(control)
      const selectedProject = selector(`stand-in-connect-project-${project.id}`)
      await control.command('waitFor', `${selectedProject}[aria-checked="false"]`)
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
      await control.command('fill', selector('stand-in-search-project-scope'), {
        value: projectName,
      })
      await control.command('clickWhenEnabled', selectedProject)
      await control.command('waitFor', `${selectedProject}[aria-checked="true"]`)
      const pending = selector('stand-in-connections-pending')
      await control.command('waitFor', selector('stand-in-onboarding-save-connections'), {
        text: '保存接收范围',
        enabled: true,
      })
      await control.command('waitFor', selector('stand-in-onboarding-complete'), { visible: false })
      await control.command('waitFor', selector('stand-in-onboarding-navigation'), {
        text: '协作项目',
      })
      await control.command('waitFor', `${selector('stand-in-path-scope')}[aria-current="page"]`)
      await control.command('waitFor', back)
      await control.command('waitFor', back, { text: '返回协作项目', enabled: true })
      assert.equal(
        await control.command('getElementCount', `${selector('stand-in-onboarding')} ${back}`),
        '1'
      )
      const drop = selector('stand-in-onboarding-drop-scope')
      const scopeRow = selector('stand-in-project-open-scope-projects')
      await control.command('waitFor', drop, { text: '放弃', enabled: true })
      await captureScreenshot(control, 'stand-in-onboarding-project-save-or-discard.png')
      await control.command('clickWhenEnabled', back)
      await control.command('waitFor', back, { text: '返回助理设置' })
      await control.command('waitFor', selector('stand-in-project-add-scope'))
      await control.command('waitFor', scopeRow, { visible: false })
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
      await openProjectScopeDetails(control)
      await control.command('waitFor', `${selectedProject}[aria-checked="false"]`)
      await control.command('clickWhenEnabled', selectedProject)
      await control.command('clickWhenEnabled', drop)
      await control.command('waitFor', selector('stand-in-project-add-scope'))
      await control.command('waitFor', scopeRow, { visible: false })
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), before)
      await captureScreenshot(control, 'stand-in-onboarding-project-discarded.png')
      await control.command('clickWhenEnabled', back)
      await control.command('waitFor', pending, { visible: false })
      await control.command('clickWhenEnabled', selector('stand-in-add-dingtalk-connection'))
      await control.command('waitFor', back)
      await control.command('waitFor', pending, { visible: false })
      await captureScreenshot(control, 'stand-in-onboarding-dingtalk-without-local-changes.png')
      await control.command('clickWhenEnabled', back)
      await control.command('clickWhenEnabled', selector('stand-in-onboarding-complete'))
      await control.command('waitFor', selector('stand-in-onboarding'), { visible: false })
      await control.command('waitFor', CHAT, { visible: true })
      assert.equal(
        (await rpc('runtime.stand_in.onboarding.get', { userId: USER_ID })).state.completed,
        true
      )
      const afterSetup = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      assert.equal(afterSetup.primary.model.runtime, model.runtime)
      assert.equal(afterSetup.primary.model.provider, model.provider)
      assert.equal(afterSetup.primary.model.model_id, model.model_id)
      assert.equal(afterSetup.primary.enabled, true)
      assert.equal(
        Boolean(afterSetup.primary.collaboration?.enabled),
        Boolean(before.primary?.collaboration?.enabled)
      )
      if (before.primary?.collaboration)
        assert.deepEqual(afterSetup.primary.collaboration, before.primary.collaboration)
      assert.deepEqual(afterSetup.primary.connections ?? [], before.primary?.connections ?? [])
      assert.deepEqual(
        afterSetup.roles.map(role => ({ ...role, version: 0 })),
        before.roles.map(role => ({ ...role, version: 0 }))
      )
      assert.equal(
        await control.command(
          'getElementCount',
          `${selector('stand-in-conversation')} ${selector('model-selector-button')}`
        ),
        '0'
      )
      const threadId = await verifyChatModel(
        control,
        rpc,
        ONBOARDING_FIRST_MESSAGE,
        model,
        modelResponseTimeoutMs
      )
      await captureScreenshot(control, 'stand-in-chat-with-saved-model.png')
      await control.command('navigate', 'body', { value: '/' })
      await openStoryPrimary(control)
      assert.equal(await control.command('getElementCount', selector('stand-in-onboarding')), '0')
      const editor = `${CHAT} ${selector('chat-message-input')}`
      await control.command('fill', editor, { value: ONBOARDING_FOLLOWUP })
      await control.command('clickWhenEnabled', selector('stand-in-details-open'))
      assert.equal(await control.command('getElementCount', selector('stand-in-im-channels')), '0')
      await control.command('clickWhenEnabled', selector('stand-in-settings-open'))
      assert.equal(await control.command('getElementCount', selector('stand-in-im-channels')), '0')
      await captureScreenshot(control, 'stand-in-onboarding-skipped.png')
      await control.command('waitFor', selector('stand-in-primary-profile'), { visible: true })
      await control.command('clickWhenEnabled', '[data-testid="stand-in-primary-execution-toggle"]')
      await control.command(
        'waitFor',
        `${selector('stand-in-primary-execution')} ${selector('model-selector-button')}`,
        {
          text: model.label,
        }
      )
      await captureScreenshot(control, 'stand-in-change-model-in-execution-settings.png')
      await openExplicitModelMenu(
        control,
        `${selector('stand-in-primary-execution')} ${selector('model-selector-button')}`
      )
      await selectModelOption(control, defaultModel)
      await control.command('clickWhenEnabled', selector('stand-in-primary-save'))
      await control.command('waitFor', selector('stand-in-primary-profile'), { visible: false })
      const updated = await rpc('runtime.stand_in.personal.get', { userId: USER_ID })
      assert.equal(updated.primary.model.model_id, defaultModel.model_id)
      assert.equal((await control.command('getText', editor)).trim(), ONBOARDING_FOLLOWUP)
      const continued = await verifyChatModel(
        control,
        rpc,
        ONBOARDING_FOLLOWUP,
        defaultModel,
        modelResponseTimeoutMs
      )
      assert.equal(continued, threadId, 'Changing the profile model must preserve the conversation')
      await control.command('waitFor', CHAT, { text: reply(ONBOARDING_FIRST_MESSAGE) })
      await captureScreenshot(control, 'stand-in-chat-after-profile-model-change.png')
      await control.command('clickWhenEnabled', selector('stand-in-details-open'))
      await control.command('clickWhenEnabled', selector('stand-in-settings-open'))
      await control.command('clickWhenEnabled', selector('stand-in-primary-execution-toggle'))
      await verifyProjectMenuDismissal(control, 'stand-in-path-advanced')
      await control.command(
        'press',
        `${selector('stand-in-primary-execution')} ${selector('project-work-button')}`,
        { key: 'Escape' }
      )
      await control.command('waitFor', selector('stand-in-preferences'), { visible: true })
      await control.command('press', selector('stand-in-preferences'), { key: 'Escape' })
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.equal(await control.command('getActiveElementTestId', 'body'), 'stand-in-details-open')
      await control.command('clickWhenEnabled', selector('stand-in-details-open'))
      await control.command('clickWhenEnabled', selector('stand-in-settings-open'))
      await control.command('clickWhenEnabled', selector('stand-in-primary-connections-open'))
      await control.command('waitFor', selector('stand-in-available-list'), { visible: true })
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await control.command('waitFor', selector('stand-in-processing-settings-toggle'), {
        visible: false,
      })
      await control.command('waitFor', selector('stand-in-source-tags-toggle'), { visible: false })
      await addAllProjectScopes(control)
      await control.command('waitFor', selector('stand-in-processing-settings-toggle'), {
        text: '处理方式',
        visible: true,
      })
      await control.command('nativePress', selector('stand-in-processing-settings-toggle'), {
        key: 'Enter',
      })
      await control.command('waitFor', selector('stand-in-project-default-policy'), {
        visible: true,
      })
      assert.deepEqual(
        await rpc('runtime.stand_in.personal.get', { userId: USER_ID }),
        updated,
        'Inspecting processing settings must not change the saved policy'
      )
      await captureScreenshot(control, 'stand-in-processing-disclosure.png')
      await control.command('clickWhenEnabled', selector('stand-in-source-tags-toggle'))
      const tagInput = selector('stand-in-connection-tags-input')
      const invalidTag = 'Unfinished tag '.repeat(4).trim()
      await control.command('fill', tagInput, { value: invalidTag })
      await control.command('waitFor', '#stand-in-connection-tags-error', { visible: true })
      await control.command('waitFor', `${selector('stand-in-primary-save')}:disabled`)
      await control.command('clickWhenEnabled', selector('stand-in-primary-profile-close'))
      await control.command('waitFor', selector('stand-in-project-tags-keep-editing'), {
        visible: true,
      })
      await control.command('clickWhenEnabled', selector('stand-in-project-tags-keep-editing'))
      assert.equal(await control.command('getValue', tagInput), invalidTag)
      await captureScreenshot(control, 'stand-in-tag-draft-protected.png')
      await control.command('fill', tagInput, { value: '' })
      await control.command('waitFor', `${selector('stand-in-primary-save')}:enabled`)
      await control.command('fill', tagInput, { value: invalidTag })
      await control.command('clickWhenEnabled', selector('stand-in-primary-profile-close'))
      await control.command('clickWhenEnabled', selector('stand-in-project-tags-discard'))
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), updated)
      await control.command('clickWhenEnabled', selector('stand-in-create-role'))
      await control.command('waitFor', `${selector('stand-in-role-name')}:not([disabled])`, {
        visible: true,
      })
      await control.command('fill', selector('stand-in-role-name'), {
        value: 'UI draft review role',
      })
      await control.command('clickWhenEnabled', selector('stand-in-connections-open'))
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await addAllProjectScopes(control)
      await control.command('clickWhenEnabled', selector('stand-in-cancel'))
      await control.command('waitFor', selector('stand-in-project-open-scope-projects'), {
        visible: false,
      })
      await control.command('clickWhenEnabled', selector('stand-in-connections-back'))
      await control.command('clickWhenEnabled', selector('stand-in-back'))
      await captureScreenshot(control, 'stand-in-role-source-draft-discarded.png')
      await control.command('clickWhenEnabled', selector('stand-in-advanced-open'))
      await verifyProjectMenuDismissal(control, 'stand-in-path-advanced')
      await control.command('clickWhenEnabled', selector('stand-in-back'))
      assert.equal(
        await control.command('getValue', selector('stand-in-role-name')),
        'UI draft review role'
      )
      await control.command('clickWhenEnabled', selector('stand-in-connections-open'))
      await control.command('clickWhenEnabled', selector('stand-in-add-projects-connection'))
      await control.command('waitFor', selector('stand-in-project-open-scope-projects'), {
        visible: false,
      })
      await control.command('clickWhenEnabled', selector('stand-in-close'))
      await control.command('clickWhenEnabled', selector('stand-in-discard'))
      await control.command('waitFor', selector('stand-in-profile-panel'), { visible: false })
      assert.equal(await control.command('getActiveElementTestId', 'body'), 'stand-in-create-role')
      assert.deepEqual(await rpc('runtime.stand_in.personal.get', { userId: USER_ID }), updated)
    },
  }
}
