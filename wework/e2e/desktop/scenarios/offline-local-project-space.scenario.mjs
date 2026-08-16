import assert from 'node:assert/strict'

const PROJECT_NAME = '离线本地项目空间'
const TASK_NAME = '离线本地任务'
const UPDATED_TASK_NAME = '离线本地任务（已更新）'

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

export function createDesktopScenario({ uiTimeoutMs }) {
  let cloudProjectListFailures = 0
  const cloudDetailRequests = []

  return {
    async handleHttp(request, response, url) {
      if (request.method === 'GET' && url.pathname === '/api/v1/cloud-projects') {
        cloudProjectListFailures += 1
        json(response, 503, { detail: 'Desktop E2E cloud project service is unavailable' })
        return true
      }
      if (url.pathname.startsWith('/api/v1/cloud-projects/')) {
        cloudDetailRequests.push(`${request.method} ${url.pathname}`)
      }
      return false
    },

    async verify(control) {
      await control.command('waitFor', '[data-testid="workspace-tab-add"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add"]')
      await control.command('waitFor', '[data-testid="workspace-tab-add-menu"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-add-board"]')
      await control.command('waitFor', '[data-testid="cloud-todo-workspace"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-project-add"]', {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('click', '[data-testid="cloud-project-add"]')
      await control.command('waitFor', '[data-testid="cloud-project-name"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-project-name"]', {
        value: PROJECT_NAME,
      })
      await control.command('click', '[data-testid="cloud-project-location-local"]')
      await control.command('click', '[data-testid="cloud-project-task-provider-local"]')
      await control.command('clickWhenEnabled', '[data-testid="cloud-project-create-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })

      await control.command('waitFor', '[data-testid="cloud-todo-column-inbox"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-todo-add"]')
      await control.command('waitFor', '[data-testid="cloud-todo-create-panel"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-todo-title"]', {
        value: TASK_NAME,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-todo-create-confirm"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid^="cloud-todo-card-"]', {
        text: TASK_NAME,
        timeoutMs: uiTimeoutMs,
      })
      const boardSnapshot = JSON.parse(await control.command('snapshot', 'body'))
      const taskCardTestId = boardSnapshot.testIds.find(
        testId =>
          testId.startsWith('cloud-todo-card-') &&
          ![
            'cloud-todo-card-add-child-',
            'cloud-todo-card-assignee-',
            'cloud-todo-card-archive-',
            'cloud-todo-card-drop-',
            'cloud-todo-card-menu-',
            'cloud-todo-card-more-',
          ].some(prefix => testId.startsWith(prefix))
      )
      assert.ok(taskCardTestId, 'The newly created local task card was not present in the board')
      await control.command('click', `[data-testid="${taskCardTestId}"]`)
      await control.command('waitFor', '[data-testid="cloud-todo-detail"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('fill', '[data-testid="cloud-todo-detail-title"]', {
        value: UPDATED_TASK_NAME,
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-todo-save"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-todo-detail-close"]')
      await control.command('waitFor', `[data-testid="${taskCardTestId}"]`, {
        text: UPDATED_TASK_NAME,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-files-view"]')
      await control.command('waitFor', '[data-testid="cloud-files-upload"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-manage-view"]')
      await control.command('waitFor', '[data-testid="cloud-project-members-toggle"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="cloud-project-automation-view"]')
      await control.command('waitFor', '[data-testid="project-automation-view"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid^="workspace-tab-select-task-"]')
      await control.command('waitFor', '[data-testid="automation-button"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="automation-button"]')
      await control.command('waitFor', '[data-testid="create-automation-button"]', {
        timeoutMs: uiTimeoutMs,
      })

      assert.ok(
        cloudProjectListFailures > 0,
        'The scenario did not exercise an unavailable cloud project list'
      )
      assert.deepEqual(
        cloudDetailRequests,
        [],
        `Local project details unexpectedly called cloud APIs: ${cloudDetailRequests.join(', ')}`
      )
    },

    diagnostics() {
      return { cloudDetailRequests, cloudProjectListFailures }
    },
  }
}
