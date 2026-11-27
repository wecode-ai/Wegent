import assert from 'node:assert/strict'
import {
  openDirectProjectCreation,
  reloadMainWindow,
  revealCollaborationSidebarElement,
} from './workspace-flows.mjs'
import { openProjectBoard } from './collaboration-board-personal-view.mjs'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { CLOUD_PUBLIC_MODEL_NAME, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { verifyGeneratedGroupDraft } from './project-create-generated-group.mjs'
import {
  waitForProjectCreateViewport,
  assertProjectCreateActionHit,
  saveProjectCreateFocusEvidence,
  withProjectRenderer,
} from './project-create-test-utils.mjs'
import { verifyModelDialogKeyboard } from './project-create-interaction-checks.mjs'
import { confirmProjectDraftDiscard as confirmDiscard } from './project-create-dialog-navigation.mjs'
import {
  assertCollaboratorAccessibilityIsolation,
  assertCollaboratorSearchLayout,
} from './project-create-accessibility.mjs'
export {
  waitForProjectCreateViewport,
  assertProjectCreateActionHit,
} from './project-create-test-utils.mjs'
export { handleProjectCreateGroupModel } from './project-create-group-model.mjs'

const testId = value => `[data-testid="${value}"]`
const DIALOG = testId('collaboration-project-create-dialog')
const MENU = testId('collaboration-project-create-collaborator-menu')
const SEARCH = testId('collaboration-project-create-people-search')
const DISCARD = `${DIALOG} ${testId('collaboration-project-create-discard')}`
const CLOSE = `${DIALOG} ${testId('collaboration-project-create-close')}`
const CANCEL = `${DIALOG} ${testId('collaboration-project-create-cancel')}`
const BACK = testId('collaboration-project-create-configuration-back')
const readMetrics = (control, selector) => getSingleElementMetrics(control, selector, selector)
const resizeWindow = (control, width, height) =>
  control.command('setMainWindowSize', 'body', { value: JSON.stringify({ width, height }) })

async function verifyProjectCreateFocusRestoration(control, scoped) {
  const nameInput = scoped(testId('collaboration-project-name-input'))
  const opener = scoped(testId('collaboration-workspace-project-create'))
  const draftName = await control.command('getValue', nameInput)
  await control.command('nativePress', CLOSE, { key: 'Escape' })
  await confirmDiscard(control)
  await control.command('waitFor', DIALOG, { visible: false })
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', DIALOG, { visible: true })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-name-input',
    'Opening project creation with the keyboard must initially focus the name'
  )
  await control.command('nativePress', nameInput, { key: 'Escape' })
  await control.command('waitFor', DIALOG, { visible: false })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-workspace-project-create',
    'Closing project creation with Escape must restore focus to its opener'
  )
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', DIALOG, { visible: true })
  await control.command('fill', nameInput, { value: draftName })
  await control.command('nativePress', CLOSE, { key: 'Escape' })
  await confirmDiscard(control)
  await control.command('waitFor', DIALOG, { visible: false })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-workspace-project-create'
  )
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', DIALOG, { visible: true })
  await control.command('fill', nameInput, { value: draftName })
}

async function keepDraft(control, resume, action = 'Escape') {
  if (action === 'Escape') await control.command('nativePress', CLOSE, { key: 'Escape' })
  else await control.command('click', action === 'header' ? CLOSE : CANCEL)
  await control.command('waitFor', DISCARD, { visible: true })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-create-configuration-back'
  )
  assert.equal(Number(await control.command('getElementCount', `${DIALOG} form:not([hidden])`)), 0)
  const actions = JSON.parse(await control.command('getElementMetrics', `${DISCARD} footer button`))
  assert.equal(actions.length, 2)
  if (actions[0].viewportWidth <= 767)
    assert.ok(
      actions.every(button => button.height >= 44 && button.width >= 44),
      'Mobile discard actions must have 44px targets'
    )
  const back = `${DISCARD} ${BACK}`
  if (action === 'Escape') await control.command('nativePress', back, { key: 'Escape' })
  else await control.command('click', action === 'header' ? CLOSE : back)
  await control.command('waitFor', DISCARD, { visible: false })
  await control.command('waitFor', resume, { visible: true })
}

async function verifyCloudNameLength(control, scoped) {
  const input = scoped(testId('collaboration-project-name-input'))
  const submit = scoped(testId('collaboration-project-create-confirm'))
  const original = await control.command('getValue', input)
  await control.command('fill', input, { value: `  ${'😀'.repeat(101)}  ` })
  await control.command('waitFor', `${input}[aria-invalid="true"]`, { visible: true })
  const id = await control.command('getAttribute', input, { value: 'aria-describedby' })
  assert.ok(id, 'An overlong Unicode name must reference its error')
  const error = `${DIALOG} [id=${JSON.stringify(id)}]`
  const message = await control.command('getText', error)
  assert.match(message, /100/)
  assert.match(message, /101/)
  await control.command('waitFor', `${submit}:disabled`, { visible: true })
  await control.command('fill', input, { value: `  ${'😀'.repeat(100)}  ` })
  await control.command('waitFor', `${input}[aria-invalid="true"]`, { visible: false })
  await control.command('waitFor', error, { visible: false })
  await control.command('waitFor', `${submit}:not(:disabled)`, { visible: true })
  await control.command('fill', input, { value: original })
}

async function assertCollaboratorMenuBounds(control) {
  const body = await readMetrics(
    control,
    `${DIALOG} form:not([hidden]) > .collaboration-project-create-body`
  )
  const footer = await readMetrics(
    control,
    `${DIALOG} form:not([hidden]) > .collaboration-project-create-footer`
  )
  const menu = await waitForValue(
    () => readMetrics(control, MENU),
    value => value.top >= body.top - 1 && value.bottom <= Math.min(body.bottom, footer.top) + 1,
    'Collaborator popup must settle inside the scroll body',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.ok(
    menu.top >= body.top - 1 && menu.bottom <= Math.min(body.bottom, footer.top) + 1,
    `Collaborator popup escaped the scroll body or covered its footer: ${JSON.stringify({ body, footer, menu })}`
  )
  await assertProjectCreateActionHit(
    control,
    `${DIALOG} ${testId('collaboration-project-create-confirm')}`
  )
}

async function verifyTemplateRoleValidation(control, scoped) {
  const draftName = await control.command(
    'getValue',
    scoped(testId('collaboration-project-name-input'))
  )
  const advanced = scoped(testId('collaboration-project-create-advanced'))
  const description = scoped(testId('collaboration-project-description-input'))
  await control.command('click', advanced)
  await control.command('waitFor', `${advanced}[aria-expanded="true"]`, { visible: true })
  const originalDescription = await control.command('getValue', description)
  const draftDescription = `用户编写的项目说明 ${process.pid}\n保留独立验收要求与边界。😀`
  await control.command('fill', description, { value: draftDescription })
  await control.command('click', scoped(testId('project-create-choose-template')))
  await control.command('clickWhenEnabled', testId('template-details-product-lifecycle'))
  await control.command('clickWhenEnabled', testId('template-use'))
  const configuration = scoped(testId('project-create-template-configuration'))
  const apply = `${configuration} ${testId('project-create-template-configuration-apply')}`
  await control.command('waitFor', configuration, { visible: true })
  await control.command('click', scoped(testId('template-customize-main')))
  const role = scoped(testId('template-role-main-role-0'))
  await control.command('waitFor', role, { visible: true })
  const previousBinding = await control.command('getValue', role)
  assert.ok(previousBinding, 'The built-in template must begin with its real default role binding')
  await control.command('select', role, { value: '' })
  await control.command('waitFor', `${role}[aria-invalid="true"]`, { visible: true })
  const describedBy = await control.command('getAttribute', role, { value: 'aria-describedby' })
  assert.ok(describedBy, 'An unbound template role must reference its validation guidance')
  await control.command('waitFor', `${DIALOG} [id=${JSON.stringify(describedBy)}]`, {
    text: '还有角色未安排成员，请补充。',
  })
  await control.command('waitFor', `${apply}:disabled`, { visible: true })
  await control.command('select', role, { value: previousBinding })
  await control.command('waitFor', `${role}[aria-invalid="true"]`, { visible: false })
  await control.command('waitFor', `${DIALOG} [id=${JSON.stringify(describedBy)}]`, {
    visible: false,
  })
  await control.command('clickWhenEnabled', apply)
  await control.command('waitFor', configuration, { visible: false })
  assert.equal(
    await control.command('getValue', description),
    draftDescription,
    'Selecting a template must preserve the user-written project description'
  )
  const selected = scoped(testId('project-create-template-summary'))
  const summary = await control.command('getText', selected)
  await keepDraft(control, selected, 'header')
  assert.equal(await control.command('getText', selected), summary)
  assert.equal(await control.command('getValue', description), draftDescription)
  await control.command(
    'waitFor',
    scoped(`${testId('collaboration-project-create-confirm')}:not(:disabled)`),
    { visible: true }
  )
  assert.equal(
    await control.command('getValue', scoped(testId('collaboration-project-name-input'))),
    draftName
  )
  await control.command('click', scoped(testId('project-create-clear-template')))
  await control.command('waitFor', role, { visible: false })
  assert.equal(
    await control.command('getValue', description),
    draftDescription,
    'Removing a template must retain the original description and its line breaks'
  )
  await control.command('fill', description, { value: originalDescription })
  await control.command('click', advanced)
  await control.command('waitFor', `${advanced}[aria-expanded="false"]`, { visible: true })
}

async function withProjectCreationAgents(request, workspace, verify) {
  const cleanups = []
  const agentsPath = `/api/v1/workspaces/${workspace.id}/agents`
  const create = (path, values) => request(path, { method: 'POST', body: JSON.stringify(values) })
  try {
    const bot = await create('/api/bots', {
      name: `project-create-keyboard-bot-${process.pid}`,
      namespace: 'default',
      shell_name: 'Codex',
      agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
    })
    cleanups.push(() => request(`/api/bots/${bot.id}`, { method: 'DELETE' }))
    const resources = []
    for (const suffix of ['coordinator', 'worker']) {
      const team = await create('/api/teams', {
        name: `project-create-${suffix}-${process.pid}`,
        namespace: 'default',
        bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
        bind_mode: ['task'],
        requires_workspace: false,
        is_active: true,
      })
      cleanups.push(() =>
        request(`/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`, {
          method: 'DELETE',
        })
      )
      resources.push(await create(agentsPath, { team_id: team.id }))
      cleanups.push(() => request(`${agentsPath}/${team.id}`, { method: 'DELETE' }))
    }
    await verify(resources)
  } finally {
    const failures = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length)
      throw new AggregateError(failures, 'Project creation agents cleanup failed')
  }
}

function visibleButtonCenters(metrics) {
  return metrics.flatMap((button, index) => {
    const intersection = button.visibleIntersection
    const x = (button.left + button.right) / 2
    const y = (button.top + button.bottom) / 2
    return button.visible &&
      intersection &&
      x >= intersection.left &&
      x <= intersection.right &&
      y >= intersection.top &&
      y <= intersection.bottom
      ? [{ ...button, index }]
      : []
  })
}

async function assertModelMenuCenters(indices) {
  return withProjectRenderer(async (client, target) => {
    const result = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
        const buttons = document.querySelectorAll('[data-testid="model-selector-menu"] button')
        return ${JSON.stringify(indices)}.map(index => {
          const button = buttons[index]
          if (!button) return { index, hit: false }
          const rect = button.getBoundingClientRect()
          const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)
          return { index, hit: hit === button || (hit !== null && button.contains(hit)) }
        })
      })()`,
      },
    })
    assert.equal(result.result?.value?.length, indices.length)
    assert.ok(
      result.result.value.every(button => button.hit),
      `A visible model menu button has an obstructed center: ${JSON.stringify(result.result.value)}`
    )
  })
}

async function verifyMobileGroupConfiguration(control, configuration) {
  const previousSize = await resizeWindow(control, 375, 812)
  const original = JSON.parse(previousSize)
  try {
    await waitForProjectCreateViewport(control, 375, 812)
    const back = await readMetrics(control, `${configuration} ${BACK}`)
    assert.ok(
      back.width >= 44 && back.height >= 44,
      'Mobile configuration Back must have a 44px target'
    )
    const generate = `${configuration} ${testId('collaboration-project-create-generate-group')}`
    await control.command('scrollIntoView', generate, { visible: true })
    const group = await readMetrics(control, configuration)
    const body = await readMetrics(
      control,
      `${configuration} .collaboration-project-create-configuration-body`
    )
    const action = await readMetrics(control, generate)
    assert.ok(
      group.scrollWidth <= group.clientWidth,
      `Mobile group configuration overflowed: ${JSON.stringify(group)}`
    )
    assert.ok(
      body.scrollWidth <= body.clientWidth,
      `Mobile group body overflowed: ${JSON.stringify(body)}`
    )
    assert.ok(
      action.left >= body.left &&
        action.right <= Math.min(group.right, body.right, action.viewportWidth),
      `Generate responsibilities escaped the mobile content column: ${JSON.stringify({ group, body, action })}`
    )
    await control.command('clickWhenEnabled', `${configuration} ${testId('model-selector-button')}`)
    const menu = testId('model-selector-menu')
    await control.command('waitFor', menu, { visible: true })
    if (
      Number(
        await control.command('getElementCount', `${menu} [data-testid^="model-option-"]`, {
          visible: true,
        })
      ) === 0
    ) {
      await control.command('clickWhenEnabled', `${menu} ${testId('model-advanced-toggle')}`)
    }
    const buttons = await waitForValue(
      async () =>
        visibleButtonCenters(
          JSON.parse(
            await control.command('getElementMetrics', `${menu} button`, {
              value: JSON.stringify({ includeText: true, attributeNames: ['data-testid'] }),
            })
          )
        ),
      values =>
        values.some(button => button.testId?.startsWith('model-option-')) &&
        values.every(button => button.height >= 44 && button.width >= 44),
      'Visible mobile model buttons must expose 44px touch targets',
      DEFAULT_STEP_TIMEOUT_MS
    )
    await assertModelMenuCenters(buttons.map(button => button.index))
    const option = buttons.find(button => button.testId?.startsWith('model-option-'))
    await control.command('nativePress', `${menu} ${testId(option.testId)}`, { key: 'Escape' })
    await control.command('waitFor', menu, { visible: false })
    await control.command('waitFor', configuration, { visible: true })
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
    await waitForProjectCreateViewport(control, original.width, original.height)
  }
}

async function verifyGroupConfigurationDraft(control, scoped, workspace, agents) {
  // API-created fixtures must replace the workspace's previously cached empty catalog.
  await reloadMainWindow(control, 'The group configuration fixtures did not reconnect after reload')
  await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
    visible: true,
  })
  await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
  const home = scoped(testId('collaboration-primary-home'))
  await revealCollaborationSidebarElement(control, home)
  await control.command('click', home)
  await control.command('waitFor', scoped(testId('personal-home')), { visible: true })
  await control.command('click', scoped(testId('personal-home-tab-stand-in')))
  await control.command('waitFor', scoped(testId('right-workspace-chat-composer-shell')), {
    visible: true,
  })
  const actions = scoped(
    `${testId(`collaboration-workspace-tree-${workspace.id}`)} .collaboration-workspace-action-trigger`
  )
  await revealCollaborationSidebarElement(control, actions)
  await control.command('click', actions)
  await control.command('click', testId('collaboration-workspace-nav-create-project'))
  await control.command('click', testId('collaboration-workspace-nav-create-blank-project'))
  await control.command('waitFor', DIALOG, { visible: true })
  const nameInput = scoped(testId('collaboration-project-name-input'))
  const draftName = `Group configuration draft ${process.pid}`
  await control.command('fill', nameInput, { value: draftName })
  await resizeWindow(control, 1024, 768)
  await waitForProjectCreateViewport(control)
  await assertProjectCreateActionHit(
    control,
    scoped(testId('collaboration-project-create-confirm'))
  )
  for (const agent of agents) {
    await control.command('click', scoped(testId('collaboration-project-create-add-collaborator')))
    await control.command('click', testId('collaboration-project-create-collaborator-tab-agents'))
    await control.command(
      'clickWhenEnabled',
      testId(`collaboration-project-create-agent-${agent.team_id}`)
    )
    await control.command('waitFor', MENU, { visible: false })
  }
  const opener = scoped(testId('collaboration-project-create-organize-group'))
  const configuration = scoped(testId('collaboration-project-create-model-picker'))
  const back = `${configuration} ${BACK}`
  const assertDraftRetained = async () => {
    await control.command('waitFor', configuration, { visible: false })
    await control.command('waitFor', DIALOG, { visible: true })
    assert.equal(await control.command('getValue', nameInput), draftName)
    const tokens = scoped('.collaboration-project-create-collaborator-tokens')
    for (const agent of agents) await control.command('waitFor', tokens, { text: agent.name })
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      'collaboration-project-create-organize-group'
    )
  }
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', configuration, { visible: true })
  const firstFocusedId = await control.command('getActiveElementTestId', 'body')
  if (!firstFocusedId)
    await saveProjectCreateFocusEvidence('project-create-initial-focus-failure', configuration)
  assert.ok(firstFocusedId, 'Group configuration must focus an interactive control')
  const firstControl = `${configuration} ${testId(firstFocusedId)}`
  assert.equal(
    Number(await control.command('getElementCount', firstControl)),
    1,
    'Opening group configuration left focus outside its controls'
  )
  await resizeWindow(control, 1024, 768)
  await waitForProjectCreateViewport(control)
  await verifyModelDialogKeyboard(control, configuration)
  await verifyMobileGroupConfiguration(control, configuration)
  await control.command('nativePress', back, { key: 'Tab' })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-create-close',
    'Tab must wrap to the shared dialog header from group configuration'
  )
  await control.command('nativePress', CLOSE, {
    key: 'Shift+Tab',
  })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-create-configuration-back',
    'Shift+Tab must wrap from the shared dialog header to group configuration'
  )
  await control.command('nativePress', back, { key: 'Escape' })
  await assertDraftRetained()
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', configuration, { visible: true })
  await control.command('click', back)
  await assertDraftRetained()
  await control.command('click', scoped(testId('collaboration-project-create-add-collaborator')))
  await control.command('click', testId('collaboration-project-create-collaborator-tab-groups'))
  const menuEntry = `${MENU} ${testId('collaboration-project-create-new-group')}`
  await control.command('waitFor', `${menuEntry}:not(:disabled)`, { visible: true })
  await control.command('nativePress', menuEntry, { key: 'Enter' })
  await control.command('waitFor', configuration, { visible: true })
  await control.command('nativePress', back, { key: 'Escape' })
  await control.command('waitFor', configuration, { visible: false })
  await control.command('waitFor', DIALOG, { visible: true })
  // Returning restores the collaborator trigger and its scroll position, not the name field.
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${DIALOG} form:not([hidden]) ${testId('collaboration-project-name-input')}`
      )
    ),
    1,
    'Returning from group configuration must restore the project form'
  )
  assert.equal(await control.command('getValue', nameInput), draftName)
  for (const agent of agents) {
    await control.command('waitFor', scoped('.collaboration-project-create-collaborator-tokens'), {
      text: agent.name,
    })
  }
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-create-add-collaborator',
    'Leaving group configuration opened from its removed menu entry must focus Add collaborator'
  )
  await control.command('nativePress', opener, { key: 'Enter' })
  await control.command('waitFor', configuration, { visible: true })
  await verifyGeneratedGroupDraft(control, scoped, configuration, agents, draftName, {
    keepDraft,
    assertCollaboratorMenuBounds,
  })
  await control.command('nativePress', CLOSE, { key: 'Escape' })
  await confirmDiscard(control)
  await control.command('waitFor', DIALOG, { visible: false })
}

export async function verifyProjectCreateDialogUi(control, scoped) {
  const previousSize = await resizeWindow(control, 1024, 768)
  try {
    await waitForProjectCreateViewport(control)
    await verifyCloudNameLength(control, scoped)
    const labelledBy = await control.command('getAttribute', DIALOG, {
      value: 'aria-labelledby',
    })
    assert.ok(labelledBy, 'Project creation dialog must have an accessible name')
    const title = `${DIALOG} h2[id=${JSON.stringify(labelledBy)}]`
    assert.equal(Number(await control.command('getElementCount', title)), 1)
    assert.ok((await control.command('getText', title)).trim())
    assert.equal(await control.command('getAttribute', CLOSE, { value: 'aria-label' }), '关闭')
    await assertProjectCreateActionHit(
      control,
      scoped(testId('collaboration-project-create-confirm'))
    )
    const advanced = scoped(testId('collaboration-project-create-advanced'))
    assert.match(await control.command('getText', advanced), /说明、任务来源/)
    assert.equal(
      await control.command('getAttribute', advanced, { value: 'aria-expanded' }),
      'false'
    )
    await control.command('nativePress', scoped(testId('collaboration-project-create-confirm')), {
      key: 'Tab',
    })
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      'collaboration-project-create-close',
      'Tab escaped the project creation dialog instead of wrapping to its first control'
    )
    await control.command('nativePress', CLOSE, {
      key: 'Shift+Tab',
    })
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      'collaboration-project-create-confirm',
      'Shift+Tab escaped the project creation dialog instead of wrapping to its last control'
    )

    await control.command('nativePress', scoped(testId('project-create-choose-template')), {
      key: 'Enter',
    })
    const templateCatalog = `${DIALOG} ${testId('project-create-template-catalog')}`
    await control.command('waitFor', templateCatalog, { visible: true })
    assert.equal(
      Number(
        await control.command(
          'getElementCount',
          `${DIALOG} [role="dialog"], ${DIALOG} dialog[open]`
        )
      ),
      0,
      'Template configuration must reuse the parent dialog'
    )
    await control.command('nativePress', `${templateCatalog} ${BACK}`, { key: 'Escape' })
    await control.command('waitFor', templateCatalog, { visible: false })
    await control.command('waitFor', DIALOG, { visible: true })
    await verifyTemplateRoleValidation(control, scoped)

    for (const visibility of ['public', 'private']) {
      const selected = scoped(testId(`cloud-project-visibility-${visibility}`))
      await control.command('click', selected)
      assert.equal(
        await control.command('getAttribute', selected, { value: 'aria-pressed' }),
        'true'
      )
      if (visibility === 'public') {
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              `${DIALOG} p${testId('cloud-project-public-access-viewer')}`
            )
          ),
          1,
          'The fixed public Viewer permission must be explanatory text'
        )
      } else {
        assert.equal(
          Number(
            await control.command('getElementCount', testId('cloud-project-public-access-viewer'))
          ),
          0
        )
      }
    }
    for (const security of ['related', 'open']) {
      const selected = scoped(testId(`cloud-project-default-issue-security-${security}`))
      await control.command('click', selected)
      assert.equal(
        await control.command('getAttribute', selected, { value: 'aria-pressed' }),
        'true'
      )
    }

    await assertCollaboratorAccessibilityIsolation('closed', false)
    await control.command('click', scoped(testId('collaboration-project-create-add-collaborator')))
    await control.command('waitFor', MENU, { visible: true })
    await assertCollaboratorMenuBounds(control)
    await assertCollaboratorAccessibilityIsolation('open', true)
    await assertCollaboratorSearchLayout()
    const collaboratorMenuSide = await control.command('getAttribute', MENU, { value: 'data-side' })
    assert.match(collaboratorMenuSide, /^(top|bottom)$/)
    for (const [category, emptyText] of [
      ['members', '当前分组暂无其他可添加人员。'],
      ['agents', '暂无其他可添加的智能体。'],
      ['groups', '暂无其他可添加的小组。'],
    ]) {
      await control.command(
        'click',
        testId(`collaboration-project-create-collaborator-tab-${category}`)
      )
      await control.command('fill', SEARCH, { value: '' })
      const panel = testId(`collaboration-project-create-collaborator-panel-${category}`)
      // The real workspace can contain resources prepared by another regression.
      // Assert its empty copy only when its actual resource list is empty.
      if (Number(await control.command('getElementCount', `${panel} button`)) === 0) {
        await control.command('waitFor', panel, { text: emptyText })
      }
      await control.command('fill', SEARCH, { value: `no-collaborator-${process.pid}-${category}` })
      await control.command('waitFor', panel, {
        text: '没有匹配项，请换个关键词或切换类别。',
      })
      assert.equal(Number(await control.command('getElementCount', `${panel} button`)), 0)
      assert.equal(
        await control.command('getAttribute', MENU, { value: 'data-side' }),
        collaboratorMenuSide,
        `The collaborator popup flipped when the ${category} results became empty`
      )
      if (category === 'members') {
        const status = `${MENU} ${testId('collaboration-project-create-people-search-status')}`
        await control.command('waitFor', status, { text: '没有匹配项，请换个关键词或切换类别。' })
        assert.equal(await control.command('getAttribute', status, { value: 'role' }), 'status')
        assert.equal(
          await control.command('getAttribute', status, { value: 'aria-live' }),
          'polite'
        )
        assert.equal(
          await control.command('getAttribute', status, { value: 'aria-atomic' }),
          'true'
        )
        assert.equal(
          await control.command('getActiveElementTestId', 'body'),
          'collaboration-project-create-people-search'
        )
      }
    }
    await control.command('nativePress', SEARCH, { key: 'Escape' })
    await control.command('waitFor', MENU, { visible: false })
    await control.command('waitFor', DIALOG, { visible: true })
    await assertCollaboratorAccessibilityIsolation('restored', false)
    assert.equal(
      await control.command('getActiveElementTestId', 'body'),
      'collaboration-project-create-add-collaborator',
      'Closing collaborator search must restore its trigger focus'
    )
    await assertProjectCreateActionHit(
      control,
      scoped(testId('collaboration-project-create-confirm'))
    )
    await verifyProjectCreateFocusRestoration(control, scoped)
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
}

async function verifyGitProviderValidation(control, scoped, request, workspace) {
  const projectsPath = `/api/v1/workspaces/${workspace.id}/projects`
  const projectIds = response => response.items.map(project => String(project.id)).sort()
  const before = projectIds(await request(projectsPath))
  const nameInput = scoped(testId('collaboration-project-name-input'))
  const draftName = await control.command('getValue', nameInput)
  const repository = scoped(testId('cloud-project-provider-repository'))
  const advanced = scoped(testId('collaboration-project-create-advanced'))
  await control.command('nativePress', advanced, { key: 'Enter' })
  await control.command('waitFor', `${advanced}[aria-expanded="true"]`, { visible: true })
  await control.command('nativePress', scoped(testId('cloud-project-task-provider-github')), {
    key: 'Enter',
  })
  await control.command('fill', scoped(testId('cloud-project-provider-repository')), {
    value: 'https://github.com/invalid-owner-only',
  })
  await control.command('nativePress', advanced, { key: 'Enter' })
  await control.command('waitFor', `${advanced}[aria-expanded="false"]`, { visible: true })
  await control.command('nativePress', scoped(testId('collaboration-project-create-confirm')), {
    key: 'Enter',
  })
  const error = `${DIALOG} .collaboration-project-create-error`
  await control.command('waitFor', error, { text: 'GitHub 仓库地址应包含 owner/repository' })
  await control.command('waitFor', `${advanced}[aria-expanded="true"]`, { visible: true })
  await control.command('waitFor', `${repository}:focus[aria-invalid="true"]`, { visible: true })
  const errorId = await control.command('getAttribute', error, { value: 'id' })
  const describedBy = await control.command('getAttribute', repository, {
    value: 'aria-describedby',
  })
  assert.ok(errorId && describedBy.split(/\s+/).includes(errorId))
  assert.equal(await control.command('getValue', nameInput), draftName)
  await control.command('waitFor', DIALOG, { visible: true })
  assert.deepEqual(
    projectIds(await request(projectsPath)),
    before,
    'An invalid repository must not create a cloud project'
  )

  const token = scoped(testId('cloud-project-provider-token'))
  await control.command('scrollIntoView', token, { visible: true })
  const input = await readMetrics(control, token)
  const icon = await readMetrics(control, `${DIALOG} .collaboration-project-create-token > svg`)
  const padding = Number.parseFloat(
    await control.command('getComputedStyleValue', token, { value: 'padding-left' })
  )
  assert.ok(
    input && icon && Number.isFinite(padding),
    'Token field must expose its rendered text and icon geometry'
  )
  assert.ok(
    input.left + padding >= icon.right - 1,
    `The token text overlaps its lock icon: ${JSON.stringify({ inputLeft: input.left, padding, iconRight: icon.right })}`
  )

  await control.command('fill', repository, { value: 'https://github.com/owner/repository' })
  await control.command('waitFor', `${repository}:not([aria-invalid="true"])`, { visible: true })
  await control.command('waitFor', error, { visible: false })
  assert.equal(await control.command('getValue', nameInput), draftName)
  assert.deepEqual(projectIds(await request(projectsPath)), before)
  await control.command('nativePress', scoped(testId('cloud-project-task-provider-local')), {
    key: 'Enter',
  })
  await control.command('waitFor', error, { visible: false })
  await control.command('waitFor', token, { visible: false })
  await control.command('nativePress', advanced, { key: 'Enter' })
  await control.command('waitFor', `${advanced}[aria-expanded="false"]`, { visible: true })
}

export async function verifyPrivateProjectCreation({
  control,
  scoped,
  request,
  workspace,
  project,
}) {
  await withProjectCreationAgents(request, workspace, agents =>
    verifyGroupConfigurationDraft(control, scoped, workspace, agents)
  )
  const workspaceHome = scoped(
    `${testId(`collaboration-workspace-tree-${workspace.id}`)} .collaboration-workspace-identity`
  )
  await revealCollaborationSidebarElement(control, workspaceHome)
  await control.command('click', workspaceHome)
  await openDirectProjectCreation(control, scoped('').trim())
  const name = `Private creation regression ${process.pid}`
  let created
  try {
    await control.command('fill', scoped(testId('collaboration-project-name-input')), {
      value: name,
    })
    await verifyGitProviderValidation(control, scoped, request, workspace)
    await control.command('click', scoped(testId('cloud-project-visibility-public')))
    await control.command('click', scoped(testId('cloud-project-visibility-private')))
    await control.command('click', scoped(testId('cloud-project-default-issue-security-related')))
    await control.command('click', scoped(testId('cloud-project-default-issue-security-open')))
    await control.command(
      'clickWhenEnabled',
      scoped(testId('collaboration-project-create-confirm'))
    )
    await control.command('waitFor', DIALOG, { visible: false })
    const response = await request(`/api/v1/workspaces/${workspace.id}/projects`)
    created = response.items.find(candidate => candidate.name === name)
    assert.ok(created, 'Private project creation did not persist')
    assert.equal(created.visibility, 'private')
    assert.equal(created.default_issue_security, 'open')
    assert.ok(!created.public_access, 'A private project retained the public Viewer grant')
  } finally {
    if (created) {
      const latest = await request(`/api/v1/cloud-projects/${created.id}`)
      await request(`/api/v1/cloud-projects/${created.id}?version=${latest.version}`, {
        method: 'DELETE',
      })
      // API cleanup must also remove the fixture from the renderer's project catalog.
      await reloadMainWindow(control, 'The project fixture cleanup did not reconnect after reload')
    }
  }
  await openProjectBoard(control, scoped, project)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        scoped(testId(`collaboration-workspace-project-${created.id}`))
      )
    ),
    0,
    'The deleted private project fixture must not remain in the sidebar catalog'
  )
}
