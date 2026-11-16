import assert from 'node:assert/strict'
import { openDirectProjectCreation, revealCollaborationSidebarElement } from './workspace-flows.mjs'
import { openProjectBoard } from './collaboration-board-personal-view.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

const testId = value => `[data-testid="${value}"]`
const DIALOG = testId('collaboration-project-create-dialog')
const MENU = testId('collaboration-project-create-collaborator-menu')
const SEARCH = testId('collaboration-project-create-people-search')

export async function waitForProjectCreateViewport(control) {
  return waitForValue(
    async () => JSON.parse(await control.command('getElementMetrics', 'body'))[0],
    metrics => metrics?.viewportWidth === 1024 && metrics.viewportHeight === 768,
    'Project creation viewport did not resize to 1024x768',
    DEFAULT_STEP_TIMEOUT_MS
  )
}

export async function assertProjectCreateActionHit(control, selector) {
  await control.command('waitFor', selector, { visible: true })
  const [metrics] = JSON.parse(await control.command('getElementMetrics', selector))
  assert.ok(metrics?.hitTestVisible, `Project creation action is covered: ${selector}`)
  assert.ok(metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight)
  assert.ok(metrics.left >= 0 && metrics.right <= metrics.viewportWidth)
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

    await control.command('click', scoped(testId('project-create-choose-template')))
    const templateDialog = `${DIALOG} dialog${testId('collaboration-template-dialog')}[open]`
    await control.command('waitFor', templateDialog, { visible: true })
    await control.command(
      'nativePress',
      `${templateDialog} ${testId('collaboration-template-close')}`,
      {
        key: 'Escape',
      }
    )
    await control.command('waitFor', templateDialog, { visible: false })
    await control.command('waitFor', DIALOG, { visible: true })

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
  } finally {
    await control.command('setMainWindowSize', 'body', { value: previousSize })
  }
}

export async function verifyPrivateProjectCreation({
  control,
  scoped,
  request,
  workspace,
  project,
}) {
  const workspaceHome = scoped(testId(`collaboration-workspace-home-${workspace.id}`))
  await revealCollaborationSidebarElement(control, workspaceHome)
  await control.command('click', workspaceHome)
  await openDirectProjectCreation(control, scoped('').trim())
  const name = `Private creation regression ${process.pid}`
  let created
  try {
    await control.command('fill', scoped(testId('collaboration-project-name-input')), {
      value: name,
    })
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
