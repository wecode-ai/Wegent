import assert from 'node:assert/strict'
import {
  COLLABORATION_EXP_RHYTHM_ROLE,
  assertUnchangedGeometry,
} from './collaboration-exp-rhythm.mjs'
import { assertDesktopPanes } from './collaboration-exp-pane-verification.mjs'
import {
  assertMobileAssistantPriority,
  assertMobileNavigation,
  assertNativeWorkOpened,
  assertReducedPlanMotion,
  assertReducedStateMotion,
  assertStableStateGeometry,
  readTeam,
} from './collaboration-exp-state-motion.mjs'

export async function selectCollaborationExpAppearance(control, mode, returnRoute) {
  await control.command('navigate', 'body', { value: '/settings/appearance' })
  await control.command('waitFor', '[data-testid="appearance-settings-page"]', {
    visible: true,
  })
  await control.command('clickWhenEnabled', `[data-testid="appearance-mode-${mode}"]`)
  await control.command('waitFor', `html[data-theme="${mode}"]`)
  await control.command('navigate', 'body', { value: returnRoute })
}

/** Native role settings are a body portal, outside workspace tab content. */
export async function verifyCollaborationExpTeamManagement({
  control,
  runningRole,
  click,
  nativeTaskIdentities,
  localIssueIdentities,
}) {
  const beforeManage = await nativeTaskIdentities()
  const beforeManageIssues = await localIssueIdentities()
  await click(control, runningRole)
  const roleName =
    '[data-testid="stand-in-profile-backdrop"]:not([inert]) [data-testid="stand-in-profile-panel"] [data-testid="stand-in-role-name"]'
  await control.command('waitFor', roleName, { visible: true })
  assert.equal(await control.command('getValue', roleName), 'Integration assistant')
  assert.deepEqual(await nativeTaskIdentities(), beforeManage)
  assert.deepEqual(await localIssueIdentities(), beforeManageIssues)
}

/** Reuse one held native execution across every actual responsive presentation. */
export async function verifyCollaborationExpViewports({
  control,
  localProject,
  localIssue,
  runningIssue,
  runningAddress,
  uiTimeoutMs,
  route,
  testId,
  click,
  assertSingleton,
  openPrivate,
  nativeTaskIdentities,
  localIssueIdentities,
  captureScreenshot,
  assertNoOverflow,
  appSelector: APP,
  activeSelector: ACTIVE,
  privateInput: PRIVATE_INPUT,
  draft: DRAFT,
  onWindowSizeCaptured,
}) {
  let lightStructure
  let lightColors
  for (const [name, width, height, appearanceMode] of [
    ['wide-light', 1440, 900, 'light'],
    ['wide-dark', 1440, 900, 'dark'],
    ['mobile-light', 390, 844, 'light'],
  ]) {
    const oldSize = await control.command('setMainWindowSize', 'body', {
      value: JSON.stringify({ width, height }),
    })
    onWindowSizeCaptured(oldSize)
    await selectCollaborationExpAppearance(control, appearanceMode, route())
    await click(control, testId('collaboration-exp-navigation-assistant'))
    await control.command('setReducedMotion', 'body', { value: 'no-preference' })
    const relay = testId('collaboration-exp-team-relay')
    const runningRole = `${relay} [data-assistant-id="${COLLABORATION_EXP_RHYTHM_ROLE}"]`
    await control.command('waitFor', `${runningRole}[data-state="running"]`, {
      visible: true,
    })
    const teamBefore = await readTeam(control, relay)
    const boxesBefore = JSON.parse(await control.command('getElementMetrics', relay))
    await control.command('setReducedMotion', 'body', { value: 'reduce' })
    await assertReducedStateMotion(control, relay)
    assert.deepEqual(await readTeam(control, relay), teamBefore)
    assertUnchangedGeometry(
      boxesBefore,
      JSON.parse(await control.command('getElementMetrics', relay)),
      'Reduced-motion team'
    )
    await assertStableStateGeometry(control, relay)
    if (width === 390) {
      await assertMobileNavigation(control, testId)
      await assertMobileAssistantPriority(control, testId, runningRole)
      await assertNoOverflow(control, testId('collaboration-exp-assistant-home'), width)
    }
    await captureScreenshot(control, `collaboration-exp-team-${name}.png`, APP)
    if (name === 'wide-light') {
      await control.command('waitFor', testId('collaboration-exp-assistant-current'), {
        visible: true,
        text: runningIssue.title,
      })
      await click(control, testId('collaboration-exp-assistant-current'))
      await assertNativeWorkOpened(control, runningAddress, uiTimeoutMs)
      await control.command('navigate', 'body', { value: route() })
      await control.command('waitFor', APP, { visible: true })
    }
    await click(control, testId('collaboration-exp-navigation-tasks'))
    if (width >= 1024) {
      await control.command('waitFor', `${runningRole}[data-state="running"]`, {
        visible: true,
      })
      assert.deepEqual(await readTeam(control, relay), teamBefore)
      await assertReducedStateMotion(control, relay)
      for (const state of ['waiting', 'running', 'completed'])
        await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
          text: '1',
        })
      for (const state of ['waiting', 'running', 'completed'])
        assert.equal(
          await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
          '1'
        )
      await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
        text: runningIssue.title,
      })
      await assertStableStateGeometry(control, testId('collaboration-exp-task-rhythm'))
      await captureScreenshot(control, `collaboration-exp-rhythm-${name}.png`, APP)
      if (name === 'wide-light') {
        await click(control, testId('collaboration-exp-search-toggle'))
        await control.command('waitFor', testId('collaboration-exp-filter-status'), {
          visible: true,
        })
        assert.match(
          await control.command('getText', testId('collaboration-exp-filter-status')),
          /全部状态|All statuses/
        )
        assert.equal(
          (await control.command('getText', testId('collaboration-exp-filter-projectKey'))).trim(),
          localProject.name
        )
        await click(control, testId('collaboration-exp-filter-status'))
        await click(control, '[data-testid="collaboration-exp-filter-status-option-completed"]')
        await control.command('waitFor', testId('collaboration-exp-clear-status'), {
          visible: true,
        })
        for (const [state, expected] of [
          ['waiting', '0'],
          ['running', '0'],
          ['completed', '1'],
        ]) {
          await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
            text: expected,
          })
          assert.equal(
            await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
            expected
          )
        }
        await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
          visible: false,
        })
        assert.equal(
          Number(
            await control.command(
              'getElementCount',
              testId('collaboration-exp-task-rhythm-current')
            )
          ),
          0
        )
        assert.deepEqual(await readTeam(control, relay), teamBefore)
        await click(control, testId('collaboration-exp-clear-status'))
        await control.command('waitFor', testId('collaboration-exp-clear-status'), {
          visible: false,
        })
        for (const state of ['waiting', 'running', 'completed']) {
          await control.command('waitFor', testId(`collaboration-exp-task-rhythm-${state}`), {
            text: '1',
          })
          assert.equal(
            await control.command('getText', testId(`collaboration-exp-task-rhythm-${state}`)),
            '1'
          )
        }
        await control.command('waitFor', testId('collaboration-exp-task-rhythm-current'), {
          visible: true,
          text: runningIssue.title,
        })
        await click(control, testId('collaboration-exp-search-toggle'))
        await control.command('waitFor', testId('collaboration-exp-task-search'), {
          visible: false,
        })
        await verifyCollaborationExpTeamManagement({
          control,
          runningRole,
          click,
          nativeTaskIdentities,
          localIssueIdentities,
        })
        await control.command('navigate', 'body', { value: route() })
        await control.command('waitFor', `${runningRole}[data-state="running"]`, {
          visible: true,
        })
      }
    } else {
      await control.command('waitFor', testId('collaboration-exp-task-home'), { visible: false })
      await control.command('waitFor', testId(`collaboration-exp-task-${runningIssue.id}`), {
        visible: true,
      })
    }
    const listState = await readTaskListState(control, APP)
    await click(
      control,
      testId(
        width >= 1024
          ? 'collaboration-exp-task-rhythm-current'
          : `collaboration-exp-task-${runningIssue.id}`
      )
    )
    await assertSingleton(
      control,
      localProject,
      runningIssue,
      'local',
      JSON.stringify(['local', localProject.id])
    )
    await returnToTasks(control, testId, click, width, 'timeline')
    await assertTaskListRestored(control, APP, listState)
    await control.command('waitFor', testId(`collaboration-exp-task-${localIssue.id}`), {
      visible: true,
    })
    await click(control, testId(`collaboration-exp-task-project-${localIssue.id}`))
    await click(control, testId('collaboration-exp-project-plan'))
    await control.command(
      'waitFor',
      testId('collaboration-exp-project-plan') + '[aria-current="page"]'
    )
    await assertReducedPlanMotion(control, testId('collaboration-exp-project'))
    await returnToTasks(control, testId, click, width, 'project')
    await assertTaskListRestored(control, APP, listState)
    await click(control, testId(`collaboration-exp-task-${localIssue.id}`))
    await assertSingleton(
      control,
      localProject,
      localIssue,
      'local',
      JSON.stringify(['local', localProject.id])
    )
    await openPrivate(control)
    await control.command('fill', PRIVATE_INPUT, { value: DRAFT })
    assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
    await verifyConclusionPreview({
      control,
      testId,
      click,
      assertNoOverflow,
      width,
      privateInput: PRIVATE_INPUT,
      draft: DRAFT,
    })
    await assertNoOverflow(control, APP, width)
    await assertNoOverflow(control, testId('collaboration-exp-private-pane'), width)
    if (width === 1440) {
      const structure = JSON.parse(await control.command('snapshot', APP))
        .testIds.filter(id => id.startsWith('collaboration-exp-'))
        .sort()
      const colors = await Promise.all(
        ['color', 'background-color'].map(value =>
          control.command('getComputedStyleValue', APP, { value })
        )
      )
      if (appearanceMode === 'light') {
        lightStructure = structure
        lightColors = colors
      } else {
        assert.deepEqual(structure, lightStructure)
        assert.notDeepEqual(colors, lightColors)
      }
      await assertDesktopPanes(control, {
        appSelector: APP,
        testId,
        privateInput: PRIVATE_INPUT,
        draft: DRAFT,
      })
    } else {
      const headers = JSON.parse(
        await control.command('getElementMetrics', `${APP} .experience-header`)
      ).filter(row => row.width > 0)
      assert.equal(headers.length, 1, 'Mobile must show only the current layer')
      await click(control, testId('collaboration-exp-pane-header-discussion-back'))
      await click(control, testId('collaboration-exp-pane-header-timeline-back'))
      await click(control, testId(`collaboration-exp-task-${localIssue.id}`))
      await openPrivate(control)
      assert.equal(await control.command('getValue', PRIVATE_INPUT), DRAFT)
    }
    await captureScreenshot(control, `collaboration-exp-${name}.png`, APP)
  }
}

async function readTaskListState(control, app) {
  const snapshot = JSON.parse(await control.command('snapshot', app))
  const params = new URL(snapshot.location).searchParams
  const [scroll] = JSON.parse(
    await control.command('getElementMetrics', `${app} .experience-task-scroll`)
  )
  assert.ok(scroll?.width > 0 && scroll.height > 0, 'The real task list must be visible')
  return {
    filters: Object.fromEntries(
      ['relevance', 'projectScope', 'status', 'search', 'future'].map(key => [key, params.get(key)])
    ),
    scrollTop: scroll.scrollTop,
  }
}

async function assertTaskListRestored(control, app, expected) {
  await control.command('waitFor', `${app} [data-testid="collaboration-exp-tasks"]`, {
    visible: true,
  })
  const restored = await readTaskListState(control, app)
  assert.deepEqual(
    restored.filters,
    expected.filters,
    'Returning to tasks must preserve the exact filter scope'
  )
  assert.ok(
    Math.abs(restored.scrollTop - expected.scrollTop) <= 1,
    'Returning to tasks must preserve list scrolling'
  )
}

async function returnToTasks(control, testId, click, width, pane) {
  const back = testId(`collaboration-exp-pane-header-${pane}-back`)
  if (width >= 1024) {
    await control.command('waitFor', back, { visible: false })
    await click(control, testId('collaboration-exp-navigation-tasks'))
  } else await click(control, back)
}

async function verifyConclusionPreview({
  control,
  testId,
  click,
  assertNoOverflow,
  width,
  privateInput,
  draft,
}) {
  const form = testId('collaboration-exp-conclusion-form')
  const text = testId('collaboration-exp-conclusion-text')
  const open = testId('collaboration-exp-conclusion-open')
  const back = testId('collaboration-exp-conclusion-back')
  await click(control, open)
  await control.command('waitFor', form, { visible: true })
  await assertNoOverflow(control, form, width)
  const [box] = JSON.parse(await control.command('getElementMetrics', form))
  assert.ok(box.height > 0, 'The inline conclusion must own a real pane viewport')
  await control.command('waitFor', privateInput, { visible: false })
  await control.command('fill', text, { value: `${draft}_CONCLUSION` })
  await click(control, back)
  await control.command('waitFor', privateInput, { visible: true })
  assert.equal(await control.command('getValue', privateInput), draft)
  await click(control, open)
  await control.command('waitFor', form, { visible: true })
  assert.equal(await control.command('getValue', text), `${draft}_CONCLUSION`)
  await click(control, back)
  await control.command('waitFor', privateInput, { visible: true })
  assert.equal(await control.command('getValue', privateInput), draft)
}
