import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDevtoolsClient } from '../../../scripts/ai-verify-devtools.mjs'
import {
  openDirectProjectCreation,
  reloadMainWindow,
  revealCollaborationSidebarElement,
} from './workspace-flows.mjs'
import { openProjectBoard } from './collaboration-board-personal-view.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { CLOUD_PUBLIC_MODEL_NAME, DEFAULT_STEP_TIMEOUT_MS, resultDir } from './shared.mjs'

const testId = value => `[data-testid="${value}"]`
const DIALOG = testId('collaboration-project-create-dialog')
const MENU = testId('collaboration-project-create-collaborator-menu')
const SEARCH = testId('collaboration-project-create-people-search')

export async function waitForProjectCreateViewport(control, width = 1024, height = 768) {
  return waitForValue(
    async () => JSON.parse(await control.command('getElementMetrics', 'body'))[0],
    metrics => metrics?.viewportWidth === width && metrics.viewportHeight === height,
    `Project creation viewport did not resize to ${width}x${height}`,
    DEFAULT_STEP_TIMEOUT_MS
  )
}

export async function assertProjectCreateActionHit(control, selector) {
  await control.command('waitFor', selector, { visible: true })
  const [metrics] = JSON.parse(await control.command('getElementMetrics', selector))
  if (!metrics?.hitTestVisible)
    await saveProjectCreateFocusEvidence('project-create-hit-failure', selector)
  assert.ok(
    metrics?.hitTestVisible,
    `Project creation action is covered: ${selector}; metrics=${JSON.stringify(metrics)}`
  )
  assert.ok(metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight)
  assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewportWidth)
}

async function saveProjectCreateFocusEvidence(name, selector) {
  try {
    await collectProjectCreateFocusEvidence(name, selector)
  } catch (error) {
    console.error('Unable to capture project creation failure evidence', error)
  }
}

async function collectProjectCreateFocusEvidence(name, selector) {
  const client = await createDevtoolsClient(resultDir, DEFAULT_STEP_TIMEOUT_MS)
  const target = (await client({ action: 'targets' })).find(
    entry =>
      entry.type === 'window' &&
      entry.url.includes('/wework/app/') &&
      !entry.url.includes('startup-splash')
  )?.id
  assert.ok(target, 'The isolated renderer must be available for project focus diagnostics')
  try {
    const evidence = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
        const describe = element => {
          if (!(element instanceof HTMLElement)) return null
          const style = getComputedStyle(element)
          return { tag: element.tagName, testId: element.dataset.testid, className: element.className,
            tabIndex: element.tabIndex, tabIndexAttribute: element.getAttribute('tabindex'),
            contentEditable: element.contentEditable, disabled: element.matches(':disabled'),
            hidden: Boolean(element.closest('[hidden],[inert],[aria-hidden="true"]')),
            display: style.display, visibility: style.visibility, position: style.position,
            zIndex: style.zIndex, transform: style.transform, opacity: style.opacity,
            isolation: style.isolation, contain: style.contain, filter: style.filter }
        }
        const ancestry = element => { const chain = []; while(element) { chain.push(describe(element)); element = element.parentElement } return chain }
        const scope = document.querySelector(${JSON.stringify(selector)})
        const rect = scope?.getBoundingClientRect()
        return { active: ancestry(document.activeElement), scope: ancestry(scope),
          hit: rect ? ancestry(document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2)) : null,
          controls: scope ? Array.from(scope.querySelectorAll('input,button,select,textarea,[contenteditable]')).map(describe) : [] }
      })()`,
      },
    })
    await writeFile(
      join(resultDir, `${name}.json`),
      JSON.stringify(evidence.result?.value, null, 2)
    )
  } finally {
    await client({ action: 'detach', target })
  }
}

async function verifyProjectCreateFocusRestoration(control, scoped) {
  const nameInput = scoped(testId('collaboration-project-name-input'))
  const opener = scoped(testId('collaboration-workspace-project-create'))
  const draftName = await control.command('getValue', nameInput)
  await control.command('nativePress', nameInput, { key: 'Escape' })
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
}

async function verifyTemplateRoleValidation(control, scoped) {
  const draftName = await control.command(
    'getValue',
    scoped(testId('collaboration-project-name-input'))
  )
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
}

async function withProjectCreationAgents(request, workspace, verify) {
  const cleanups = []
  try {
    const bot = await request('/api/bots', {
      method: 'POST',
      body: JSON.stringify({
        name: `project-create-keyboard-bot-${process.pid}`,
        namespace: 'default',
        shell_name: 'Codex',
        agent_config: { bind_model: CLOUD_PUBLIC_MODEL_NAME, bind_model_type: 'public' },
      }),
    })
    cleanups.push(() => request(`/api/bots/${bot.id}`, { method: 'DELETE' }))
    const resources = []
    for (const suffix of ['coordinator', 'worker']) {
      const team = await request('/api/teams', {
        method: 'POST',
        body: JSON.stringify({
          name: `project-create-${suffix}-${process.pid}`,
          namespace: 'default',
          bots: [{ bot_id: bot.id, role: 'worker', bot_prompt: '' }],
          bind_mode: ['task'],
          requires_workspace: false,
          is_active: true,
        }),
      })
      cleanups.push(() =>
        request(`/api/teams/${team.id}?force=true&confirm_name=${encodeURIComponent(team.name)}`, {
          method: 'DELETE',
        })
      )
      resources.push(
        await request(`/api/v1/workspaces/${workspace.id}/agents`, {
          method: 'POST',
          body: JSON.stringify({ team_id: team.id }),
        })
      )
      cleanups.push(() =>
        request(`/api/v1/workspaces/${workspace.id}/agents/${team.id}`, { method: 'DELETE' })
      )
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
  const client = await createDevtoolsClient(resultDir, DEFAULT_STEP_TIMEOUT_MS)
  const target = (await client({ action: 'targets' })).find(
    entry =>
      entry.type === 'window' &&
      entry.url.includes('/wework/app/') &&
      !entry.url.includes('startup-splash')
  )?.id
  assert.ok(target, 'The isolated renderer must be available to inspect menu hit targets')
  try {
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
  } finally {
    await client({ action: 'detach', target })
  }
}

async function verifyMobileGroupConfiguration(control, configuration) {
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 375, height: 812 }),
  })
  const original = JSON.parse(previousSize)
  try {
    await waitForProjectCreateViewport(control, 375, 812)
    const generate = `${configuration} ${testId('collaboration-project-create-generate-group')}`
    await control.command('scrollIntoView', generate, { visible: true })
    const [group] = JSON.parse(await control.command('getElementMetrics', configuration))
    const [body] = JSON.parse(
      await control.command(
        'getElementMetrics',
        `${configuration} .collaboration-project-create-configuration-body`
      )
    )
    const [action] = JSON.parse(await control.command('getElementMetrics', generate))
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
  const home = scoped(
    `${testId(`collaboration-workspace-tree-${workspace.id}`)} .collaboration-workspace-identity`
  )
  await revealCollaborationSidebarElement(control, home)
  await control.command('click', home)
  await openDirectProjectCreation(control, scoped('').trim())
  const nameInput = scoped(testId('collaboration-project-name-input'))
  const draftName = `Group configuration draft ${process.pid}`
  await control.command('fill', nameInput, { value: draftName })
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
  const back = `${configuration} ${testId('collaboration-project-create-configuration-back')}`
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
  await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1024, height: 768 }),
  })
  await waitForProjectCreateViewport(control)
  await verifyMobileGroupConfiguration(control, configuration)
  await control.command('nativePress', back, { key: 'Tab' })
  assert.equal(
    await control.command('getActiveElementTestId', 'body'),
    'collaboration-project-create-close',
    'Tab must wrap to the shared dialog header from group configuration'
  )
  await control.command('nativePress', scoped(testId('collaboration-project-create-close')), {
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
  await control.command('waitFor', nameInput, { visible: true })
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
  await control.command('nativePress', nameInput, { key: 'Escape' })
  await control.command('waitFor', DIALOG, { visible: false })
}

export async function verifyProjectCreateDialogUi(control, scoped) {
  const previousSize = await control.command('setMainWindowSize', 'body', {
    value: JSON.stringify({ width: 1024, height: 768 }),
  })
  try {
    await waitForProjectCreateViewport(control)
    const labelledBy = await control.command('getAttribute', DIALOG, {
      value: 'aria-labelledby',
    })
    assert.ok(labelledBy, 'Project creation dialog must have an accessible name')
    const title = `${DIALOG} h2[id=${JSON.stringify(labelledBy)}]`
    assert.equal(Number(await control.command('getElementCount', title)), 1)
    assert.ok((await control.command('getText', title)).trim())
    assert.equal(
      await control.command(
        'getAttribute',
        `${DIALOG} ${testId('collaboration-project-create-close')}`,
        {
          value: 'aria-label',
        }
      ),
      '关闭'
    )
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
    await control.command('nativePress', scoped(testId('collaboration-project-create-close')), {
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
    await control.command(
      'nativePress',
      `${templateCatalog} ${testId('collaboration-project-create-configuration-back')}`,
      {
        key: 'Escape',
      }
    )
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

    await control.command('click', scoped(testId('collaboration-project-create-add-collaborator')))
    await control.command('waitFor', MENU, { visible: true })
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
    }
    await control.command('nativePress', SEARCH, { key: 'Escape' })
    await control.command('waitFor', MENU, { visible: false })
    await control.command('waitFor', DIALOG, { visible: true })
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
  const advanced = scoped(testId('collaboration-project-create-advanced'))
  await control.command('nativePress', advanced, { key: 'Enter' })
  await control.command('waitFor', `${advanced}[aria-expanded="true"]`, { visible: true })
  await control.command('nativePress', scoped(testId('cloud-project-task-provider-github')), {
    key: 'Enter',
  })
  await control.command('fill', scoped(testId('cloud-project-provider-repository')), {
    value: 'https://github.com/invalid-owner-only',
  })
  await control.command('nativePress', scoped(testId('collaboration-project-create-confirm')), {
    key: 'Enter',
  })
  const error = `${DIALOG} .collaboration-project-create-error`
  await control.command('waitFor', error, { text: 'GitHub 仓库地址应包含 owner/repository' })
  await control.command('waitFor', DIALOG, { visible: true })
  assert.deepEqual(
    projectIds(await request(projectsPath)),
    before,
    'An invalid repository must not create a cloud project'
  )

  const token = scoped(testId('cloud-project-provider-token'))
  await control.command('scrollIntoView', token, { visible: true })
  const [input] = JSON.parse(await control.command('getElementMetrics', token))
  const [icon] = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${DIALOG} .collaboration-project-create-token > svg`
    )
  )
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
    }
  }
  await openProjectBoard(control, scoped, project)
}
