import assert from 'node:assert/strict'
import { getSingleElementMetrics } from './conversation-layout.mjs'
import { CLOUD_PUBLIC_MODEL_NAME, DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import {
  GENERATED_GROUP_NAME,
  GROUP_DRAFT_REQUEST,
  INCOMPLETE_GROUP_DRAFT_REQUEST,
} from './project-create-group-model.mjs'
import {
  waitForProjectCreateViewport,
  assertProjectCreateActionHit,
  withProjectRenderer,
} from './project-create-test-utils.mjs'
import { assertMobileInlineTarget } from './project-create-interaction-checks.mjs'

const testId = value => `[data-testid="${value}"]`
const MENU = testId('collaboration-project-create-collaborator-menu')
const SEARCH = testId('collaboration-project-create-people-search')
const readMetrics = (control, selector) => getSingleElementMetrics(control, selector, selector)
const resizeWindow = (control, width, height) =>
  control.command('setMainWindowSize', 'body', { value: JSON.stringify({ width, height }) })

async function assertGeneratedGroupLayout(control, configuration) {
  const body = `${configuration} .collaboration-project-create-configuration-body`
  const save = `${configuration} ${testId('collaboration-project-create-apply-group')}`
  const roster = await readMetrics(
    control,
    `${configuration} ${testId('collaboration-project-create-group-roster')}`
  )
  const duties = JSON.parse(
    await control.command(
      'getElementMetrics',
      `${configuration} .collaboration-project-create-responsibility`,
      { value: 'includeText' }
    )
  )
  assert.equal(
    duties.length,
    2,
    'Both real agent members must retain their generated responsibilities'
  )
  for (const duty of duties) {
    assert.ok(duty.text.length > 300, 'The model fixture must exercise long responsibilities')
    assert.ok(
      duty.width >= roster.width - 2,
      `A responsibility was squeezed beside its identity: ${JSON.stringify({ roster, duty })}`
    )
    assert.ok(
      duty.scrollWidth <= duty.clientWidth,
      `A responsibility overflowed horizontally: ${JSON.stringify(duty)}`
    )
  }
  await control.command(
    'scrollIntoView',
    `${configuration} ${testId('collaboration-project-create-group-name')}`
  )
  await assertProjectCreateActionHit(control, save)
  const before = await readMetrics(control, save)
  assert.ok(
    before.height >= 44 && before.width >= 44,
    'The mobile save action must have a 44px touch target'
  )
  const content = await readMetrics(control, body)
  assert.ok(
    content.scrollHeight > content.clientHeight,
    'Long responsibilities must exercise the actual scrollable draft'
  )
  assert.ok(
    content.scrollWidth <= content.clientWidth,
    `Generated draft overflowed: ${JSON.stringify(content)}`
  )
  assert.ok(Number(await control.command('scrollToBottomAsUser', body)) > 0)
  await assertProjectCreateActionHit(control, save)
  const after = await readMetrics(control, save)
  assert.ok(
    Math.abs(after.top - before.top) <= 1 && Math.abs(after.bottom - before.bottom) <= 1,
    'Scrolling long responsibilities moved the save action out of its fixed footer'
  )
}

async function readGenerationFocus(configuration) {
  return withProjectRenderer(async (client, target) => {
    const result = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: {
        returnByValue: true,
        expression: `(() => {
          const scope = document.querySelector(${JSON.stringify(configuration)})
          if (!scope) return null
          const visible = element => element && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getBoundingClientRect().height > 0
          const instructions = scope.querySelector('[data-testid="collaboration-project-create-generation-instructions"]')
          const result = scope.querySelector('[data-testid="collaboration-project-create-group-name"]')
          const save = scope.querySelector('[data-testid="collaboration-project-create-apply-group"]')
          const alert = Array.from(scope.querySelectorAll('[role="alert"]')).find(visible)
          const progress = scope.querySelector('[data-testid="collaboration-project-create-generation-progress"]')
          const active = document.activeElement
          return {
            phase: alert ? 'error' : visible(save) && !save.disabled ? 'complete' : visible(progress) ? 'generating' : 'configuration',
            inside: scope.contains(active) && visible(active),
            instructionsFocused: active === instructions || Boolean(instructions?.contains(active)),
            resultFocused: active === result || Boolean(result?.contains(active)),
            active: { tag: active?.tagName, testId: active?.getAttribute('data-testid'), role: active?.getAttribute('role') }
          }
        })()`,
      },
    })
    return result.result?.value
  })
}

async function assertGenerationFocus(configuration, expectedPhase) {
  // Observe the first phase reached after submission without focusing any element through automation.
  const state = await waitForValue(
    () => readGenerationFocus(configuration),
    value =>
      value && (expectedPhase ? value.phase === expectedPhase : value.phase !== 'configuration'),
    'The generation focus check did not observe the expected product phase',
    DEFAULT_STEP_TIMEOUT_MS
  )
  assert.ok(state.inside, `Generation focus escaped its configuration: ${JSON.stringify(state)}`)
  if (state.phase === 'error')
    assert.ok(
      state.instructionsFocused,
      `Failed generation must focus its requirements: ${JSON.stringify(state)}`
    )
  if (state.phase === 'complete')
    assert.ok(
      state.resultFocused,
      `Completed generation must focus its editable result: ${JSON.stringify(state)}`
    )
}

async function verifyIncompleteGroupRecovery(control, configuration, agents) {
  const instructions = `${configuration} ${testId('collaboration-project-create-generation-instructions')}`
  const attachments = `${configuration} ${testId('collaboration-project-create-generation-agent-attachments')}`
  const generate = `${configuration} ${testId('collaboration-project-create-generate-group')}`
  const status = `${configuration} ${testId('collaboration-project-create-generation-status')}`
  const error = `${configuration} [role="alert"]`
  await control.command('waitFor', `${instructions}[contenteditable="true"]`, { visible: true })
  const accessibleName = await control.command('getAttribute', instructions, {
    value: 'aria-label',
  })
  assert.ok(
    accessibleName?.trim(),
    'The generation requirements editor must have an accessible name'
  )
  const request = `${INCOMPLETE_GROUP_DRAFT_REQUEST} 请为当前真实协作者生成完整、可验收的分工。`
  await control.command('fill', instructions, { value: request })
  for (const agent of agents) await control.command('waitFor', attachments, { text: agent.name })
  await control.command('clickWhenEnabled', generate)
  await assertGenerationFocus(configuration)
  // The model alone omits required sections; the real ephemeral turn and validator must reject it.
  await control.command('waitFor', error, { visible: true, timeoutMs: 30_000 })
  await control.command('waitFor', instructions, { visible: true })
  await control.command('waitFor', `${generate}:not(:disabled)`, { visible: true })
  await assertGenerationFocus(configuration, 'error')
  const message = await control.command('getText', error)
  assert.equal(message, '生成结果缺少分配原则、建议流程。请重新生成，已有要求和参与者会保留。')
  assert.doesNotMatch(message, /incomplete_group|structured|JSON/i)
  assert.doesNotMatch(await control.command('getText', status), /分工已生成/)
  assert.equal(
    Number(
      await control.command(
        'getElementCount',
        `${configuration} ${testId('collaboration-project-create-apply-group')}:not(:disabled)`,
        { visible: true }
      )
    ),
    0,
    'Incomplete generation must not expose a successful Save action'
  )
  assert.equal(
    await control.command('getValue', instructions),
    request,
    'A failed generation must preserve the user requirements for an explicit retry'
  )
  for (const agent of agents) await control.command('waitFor', attachments, { text: agent.name })
}

export async function verifyGeneratedGroupDraft(
  control,
  scoped,
  configuration,
  agents,
  draftName,
  { keepDraft, assertCollaboratorMenuBounds }
) {
  const previousSize = await resizeWindow(control, 375, 812)
  const original = JSON.parse(previousSize)
  try {
    await waitForProjectCreateViewport(control, 375, 812)
    const modelTrigger = `${configuration} ${testId('model-selector-button')}`
    await control.command('clickWhenEnabled', modelTrigger)
    const menu = testId('model-selector-menu')
    await control.command('waitFor', menu, { visible: true })
    if (Number(await control.command('getElementCount', `${menu}[data-panel="simple"]`)) > 0)
      await control.command('clickWhenEnabled', `${menu} ${testId('model-advanced-toggle')}`)
    const cloudModel = `${menu} ${testId(`model-option-${CLOUD_PUBLIC_MODEL_NAME}`)}`
    await control.command('scrollIntoView', cloudModel)
    await control.command('clickWhenEnabled', cloudModel)
    await control.command('waitFor', `${cloudModel}[aria-checked="true"]`, {})
    // Desktop model selection retains the menu for options; dismiss it explicitly.
    await control.command('nativePress', modelTrigger, { key: 'Escape' })
    await control.command('waitFor', menu, { visible: false })
    await verifyIncompleteGroupRecovery(control, configuration, agents)
    await control.command(
      'fill',
      `${configuration} ${testId('collaboration-project-create-generation-instructions')}`,
      {
        value: `${GROUP_DRAFT_REQUEST} 请为当前真实协作者生成完整、可验收的分工。`,
      }
    )
    const pendingStatus = `${configuration} ${testId('collaboration-project-create-generation-status')}`
    assert.equal(await control.command('getText', pendingStatus), '')
    await control.command(
      'clickWhenEnabled',
      `${configuration} ${testId('collaboration-project-create-generate-group')}`
    )
    await assertGenerationFocus(configuration)
    const editor = `${configuration} ${testId('collaboration-project-create-group-editor')}`
    const error = `${configuration} [role="alert"]`
    const ready = `${configuration} ${testId('collaboration-project-create-apply-group')}:not(:disabled)`
    // A failed preview stays mounted; only an enabled Save proves the real retry completed.
    await control.command('waitFor', `${ready}, ${error}`, { visible: true, timeoutMs: 30_000 })
    assert.equal(
      Number(await control.command('getElementCount', error, { visible: true })),
      0,
      `Real group generation failed: ${await control.command('getText', error)}`
    )
    await control.command('waitFor', editor, { text: GENERATED_GROUP_NAME })
    await assertGenerationFocus(configuration, 'complete')
    await keepDraft(control, editor)
    await assertGeneratedGroupLayout(control, configuration)
    const liveStatus = `${configuration} ${testId('collaboration-project-create-generation-status')}`
    assert.equal(await control.command('getAttribute', liveStatus, { value: 'role' }), 'status')
    assert.equal(
      await control.command('getAttribute', liveStatus, { value: 'aria-live' }),
      'polite'
    )
    assert.equal(
      await control.command('getAttribute', liveStatus, { value: 'aria-atomic' }),
      'true'
    )
    await control.command('waitFor', liveStatus, { text: '分工已生成，可编辑并保存。' })
    // The real parsed roster places the owner first; the fixture supplies two agent duties.
    const responsibility = `${editor} .collaboration-group-roster-item:nth-child(2) .collaboration-project-create-responsibility`
    const editResponsibility = `${responsibility} button`
    const originalResponsibility = await control.command(
      'getText',
      `${responsibility} .collaboration-project-create-hover-editable > span`
    )
    assert.equal(
      originalResponsibility.split('\n').length,
      2,
      'Independent responsibility entries must retain their explicit line boundary'
    )
    await control.command('scrollIntoView', editResponsibility, { visible: true })
    await control.command('click', editResponsibility)
    const responsibilityInput = `${responsibility} textarea`
    await control.command('fill', responsibilityInput, { value: '短职责' })
    await assertMobileInlineTarget(control, responsibilityInput)
    await control.command('fill', responsibilityInput, { value: originalResponsibility })
    await control.command('nativePress', responsibilityInput, { key: 'Escape' })
    await control.command('waitFor', responsibilityInput, { visible: false })
    const name = `${editor} ${testId('collaboration-project-create-group-name')}`
    const nameInput = `${editor} > header input`
    const editButton = `${editor} > header .collaboration-project-create-hover-editable > button`
    let editedName
    for (const key of ['Escape', 'Enter']) {
      editedName = `分工草稿 ${key} 已编辑`
      await control.command('nativePress', name, { key: 'Enter' })
      await control.command('fill', nameInput, { value: editedName })
      await assertMobileInlineTarget(control, nameInput)
      await control.command('nativePress', nameInput, { key })
      await control.command('waitFor', nameInput, { visible: false })
      await control.command('waitFor', name, { text: editedName })
      await control.command('waitFor', configuration, { visible: true })
      assert.equal(
        Number(await control.command('getElementCount', `${editButton}:focus`)),
        1,
        `${key} must finish editing and restore its edit control, preserving the draft`
      )
      await assertProjectCreateActionHit(
        control,
        `${configuration} ${testId('collaboration-project-create-apply-group')}`
      )
    }
    await control.command('setMainWindowSize', 'body', { value: previousSize })
    await waitForProjectCreateViewport(control, original.width, original.height)
    await assertProjectCreateActionHit(
      control,
      `${configuration} ${testId('collaboration-project-create-apply-group')}`
    )
    await control.command(
      'clickWhenEnabled',
      `${configuration} ${testId('collaboration-project-create-apply-group')}`
    )
    await control.command('waitFor', configuration, { visible: false })
    const summary = scoped(testId('collaboration-project-create-group-summary'))
    await control.command('waitFor', summary, { text: editedName })
    await keepDraft(control, summary, 'back')
    await control.command('waitFor', summary, { text: editedName })
    assert.equal(
      await control.command('getValue', scoped(testId('collaboration-project-name-input'))),
      draftName
    )
    for (const agent of agents) await control.command('waitFor', summary, { text: agent.name })
    assert.equal(
      await control.command(
        'getText',
        `${summary} .collaboration-project-create-group-members > span:nth-child(2) small`
      ),
      originalResponsibility,
      'Saving responsibilities must preserve every entry and its line boundary'
    )
    await resizeWindow(control, 375, 812)
    await waitForProjectCreateViewport(control, 375, 812)
    const discover = scoped(testId('project-create-choose-template'))
    await control.command('scrollIntoView', discover)
    const discoverSize = await readMetrics(control, discover)
    assert.ok(
      discoverSize.width >= 44 && discoverSize.height >= 44,
      'Mobile Discover templates must have a 44px target'
    )
    const add = scoped(testId('collaboration-project-create-add-collaborator'))
    await control.command('scrollIntoView', add)
    await control.command('click', add)
    await control.command('waitFor', MENU, { visible: true })
    await assertCollaboratorMenuBounds(control)
    await control.command('nativePress', SEARCH, { key: 'Escape' })
    await control.command('waitFor', MENU, { visible: false })
    await control.command('waitFor', summary, { text: editedName })
    await control.command('click', `${summary} .collaboration-project-create-group-remove`)
    await control.command('waitFor', summary, { visible: false })
    for (const agent of agents)
      await control.command(
        'waitFor',
        scoped('.collaboration-project-create-collaborator-tokens'),
        { text: agent.name }
      )
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
    await waitForProjectCreateViewport(control, original.width, original.height)
  }
}
