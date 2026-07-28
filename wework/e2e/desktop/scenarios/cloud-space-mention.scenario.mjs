import assert from 'node:assert/strict'

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const COMPOSER_SELECTOR = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="chat-message-input"][contenteditable="true"]`

const WEBSITE_PROJECT = {
  id: '896185331840201807',
  public_id: 'e2e-public-website',
  project_key: 'GW',
  name: '官网改版',
  description: '官网改版协作空间',
  created_by_user_id: 9001,
  status: 'active',
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
}
const MOBILE_PROJECT = {
  ...WEBSITE_PROJECT,
  id: '617164117691150677',
  public_id: 'e2e-public-mobile',
  project_key: 'MB',
  name: '移动端重构',
  description: '',
}
const WEBSITE_TODO = {
  id: 'GW-1',
  cloud_project_id: WEBSITE_PROJECT.id,
  sequence_number: 1,
  parent_id: null,
  created_by_user_id: 9001,
  assignee_user_id: null,
  title: '接入新版登录页',
  description: '',
  status: 'in_progress',
  priority: 'high',
  due_at: null,
  sort_order: 0,
  current_delivery_id: null,
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
  completed_at: null,
}
const WEBSITE_FILE = {
  id: '1906534447060216960',
  cloud_project_id: WEBSITE_PROJECT.id,
  path: '需求文档.md',
  name: '需求文档.md',
  kind: 'file',
  content_type: 'text/markdown',
  size_bytes: 12,
  sha256: null,
  description: '',
  created_by_user_id: 9001,
  updated_by_user_id: 9001,
  version: 1,
  created_at: '2026-07-25T00:00:00',
  updated_at: '2026-07-25T00:00:00',
}

async function readJson(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function snapshot(control) {
  return JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs }) {
  const capture = (control, name) => captureScreenshot(control, name, ACTIVE_WORKBENCH_SELECTOR)
  const projects = [WEBSITE_PROJECT, MOBILE_PROJECT]
  let createdProjectPayload = null

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        json(response, 200, { items: projects })
        return true
      }
      if (request.method === 'POST' && url.pathname === '/api/v1/cloud-projects') {
        createdProjectPayload = await readJson(request)
        const created = {
          ...WEBSITE_PROJECT,
          id: '702251189240268801',
          public_id: 'e2e-public-created',
          project_key: createdProjectPayload.project_key ?? 'E2E',
          name: createdProjectPayload.name,
          description: createdProjectPayload.description ?? '',
        }
        projects.unshift(created)
        json(response, 200, created)
        return true
      }
      const loopItemsMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/loop-items$/)
      if (request.method === 'GET' && loopItemsMatch) {
        json(response, 200, {
          items: loopItemsMatch[1] === WEBSITE_PROJECT.id ? [WEBSITE_TODO] : [],
        })
        return true
      }
      const filesMatch = url.pathname.match(/^\/api\/v1\/cloud-projects\/([^/]+)\/files$/)
      if (request.method === 'GET' && filesMatch) {
        json(response, 200, {
          items: filesMatch[1] === WEBSITE_PROJECT.id ? [WEBSITE_FILE] : [],
        })
        return true
      }
      return false
    },

    async verify(control) {
      await control.command('waitFor', COMPOSER_SELECTOR, { timeoutMs: uiTimeoutMs })

      // Scene 1: the @ menu exposes the direct cloud space row and the project
      // space list entry; the retired entries are gone.
      await control.command('fill', COMPOSER_SELECTOR, { value: '@' })
      await control.command('waitFor', '[data-testid="mention-cloud-space-direct-action"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="mention-cloud-projects-action"]', {
        timeoutMs: uiTimeoutMs,
      })
      const menuSnapshot = await snapshot(control)
      assert.ok(
        !menuSnapshot.testIds.includes('mention-cloud-space'),
        'The retired cloud space drill entry is still rendered'
      )
      assert.ok(
        !menuSnapshot.testIds.includes('mention-cloud-create-action'),
        'The retired create action is still rendered'
      )
      await capture(control, 'cloud-space-mention-01-menu-entries.png')

      // Scene 2: the direct row inserts the generic cloud://projects chip
      // without binding anything.
      await control.command('click', '[data-testid="mention-cloud-space-direct-action"]')
      const directSnapshot = await snapshot(control)
      assert.ok(
        !directSnapshot.testIds.includes('mention-cloud-space-direct-action'),
        'Selecting the direct row did not close the mention menu'
      )
      assert.ok(
        directSnapshot.text.includes('项目空间'),
        'The direct row did not insert the generic 项目空间 mention chip'
      )
      assert.ok(
        !directSnapshot.testIds.includes('transient-notice'),
        'The generic reference unexpectedly bound a cloud context'
      )
      await capture(control, 'cloud-space-mention-02-direct-chip.png')

      // Scene 3: the project space list drills into every accessible project.
      await control.command('fill', COMPOSER_SELECTOR, { value: '@' })
      await control.command('waitFor', '[data-testid="mention-cloud-projects-action"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="mention-cloud-projects-action"]')
      await control.command(
        'waitFor',
        `[data-testid="cloud-reference-option-cloud-project-space-${WEBSITE_PROJECT.id}"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const drillSnapshot = await snapshot(control)
      assert.ok(
        drillSnapshot.testIds.includes(
          `cloud-reference-option-cloud-project-space-${MOBILE_PROJECT.id}`
        ),
        'The project space drill did not list every accessible cloud project'
      )
      assert.ok(
        drillSnapshot.testIds.includes('mention-cloud-back-action'),
        'The project space drill lost its back row'
      )
      await capture(control, 'cloud-space-mention-03-project-list.png')

      // Scene 4: selecting a project inserts the mention chip and binds the space.
      await control.command(
        'click',
        `[data-testid="cloud-reference-option-cloud-project-space-${WEBSITE_PROJECT.id}"]`
      )
      await control.command('waitFor', '[data-testid="transient-notice"]', {
        text: '已绑定项目空间',
        timeoutMs: uiTimeoutMs,
      })
      const boundSnapshot = await snapshot(control)
      assert.ok(
        boundSnapshot.text.includes('项目空间:官网改版'),
        'Selecting a project did not insert the 项目空间 mention chip'
      )

      // Scene 5: the bound space candidates surface through plain query
      // filtering, todos carry their status badge.
      await control.command('fill', COMPOSER_SELECTOR, { value: '@GW' })
      await control.command('waitFor', '[data-testid="cloud-reference-option-cloud-todo-GW-1"]', {
        timeoutMs: uiTimeoutMs,
      })
      const spaceSnapshot = await snapshot(control)
      assert.ok(
        spaceSnapshot.testIds.includes('cloud-reference-status-cloud-todo-GW-1'),
        'The todo row did not render its status badge'
      )
      await capture(control, 'cloud-space-mention-04-bound-filter.png')
      await control.command('click', '[data-testid="cloud-reference-option-cloud-todo-GW-1"]')
      const todoSnapshot = await snapshot(control)
      assert.ok(
        todoSnapshot.text.includes('任务:GW'),
        'Selecting a todo did not insert the 任务 mention chip'
      )

      // Scene 6: the typed scope pins the direct row above filtered projects.
      await control.command('fill', COMPOSER_SELECTOR, { value: '@项目空间:官' })
      await control.command(
        'waitFor',
        `[data-testid="cloud-reference-option-cloud-project-space-${WEBSITE_PROJECT.id}"]`,
        { timeoutMs: uiTimeoutMs }
      )
      const colonSnapshot = await snapshot(control)
      assert.ok(
        colonSnapshot.testIds.includes('mention-cloud-space-direct-action'),
        'The typed scope lost the pinned direct row'
      )
      assert.ok(
        !colonSnapshot.testIds.includes(
          `cloud-reference-option-cloud-project-space-${MOBILE_PROJECT.id}`
        ),
        'The @项目空间: keyword did not filter the project list'
      )
      await capture(control, 'cloud-space-mention-05-typed-scope.png')

      // Scene 7: a non-matching typed phrase keeps only the direct row, which
      // still inserts the generic chip.
      await control.command('fill', COMPOSER_SELECTOR, { value: '@项目空间 新建项目' })
      const emptyScopeSnapshot = await snapshot(control)
      assert.ok(
        emptyScopeSnapshot.testIds.includes('mention-cloud-space-direct-action'),
        'The typed scope without matches lost the direct row'
      )
      assert.ok(
        !emptyScopeSnapshot.testIds.some(testId =>
          testId.startsWith('cloud-reference-option-cloud-project-space-')
        ),
        'A non-matching typed phrase still listed project candidates'
      )
      assert.ok(
        !emptyScopeSnapshot.testIds.includes('mention-cloud-create-action'),
        'The retired create action reappeared in the typed scope'
      )
      await control.command('click', '[data-testid="mention-cloud-space-direct-action"]')
      const genericChipSnapshot = await snapshot(control)
      assert.ok(
        genericChipSnapshot.text.includes('项目空间'),
        'The direct row in the typed scope did not insert the generic chip'
      )
    },

    diagnostics() {
      return { createdProjectPayload }
    },
  }
}
