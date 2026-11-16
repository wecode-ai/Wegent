import { expect } from '@playwright/test'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import { webApi } from '../../utils/collaboration-test-support'

// Story: a rule author can distinguish automation from their own manual actions,
// including after reload and after the rule is renamed or disabled.
projectTest(
  'attributes automated assignments to the rule and manual changes to the user',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const projectId = path.split('/').at(-1)!
    const rulesPath = `/api/v1/cloud-projects/${projectId}/automations`
    const issuePath = `/api/v1/loop-items/${issueId}`
    const user = await webApi<{ id: number; user_name: string }>(page, '/api/users/me')
    const name = `事项审阅-${crypto.randomUUID()}`
    const rule = await webApi<Resource>(page, rulesPath, {
      method: 'POST',
      body: {
        name,
        prompt: 'Assign this Issue for review.',
        trigger_type: 'event',
        event_type: 'task.status_changed',
        event_config: {
          statuses: ['in_review'],
          transition: 'any',
          execution_target: 'existing_issue',
        },
        target_kind: 'human',
        target_id: String(user.id),
        enabled: true,
      },
    })
    type History = {
      by_user_id: number
      to_id?: string
      automation?: { rule_id: string; rule_name: string; run_id: string }
    }
    type Issue = Resource & { assignment_history: History[]; status_history: History[] }
    const read = () => webApi<Issue>(page, issuePath)
    await webApi(page, issuePath, {
      method: 'PATCH',
      body: { version: (await read()).version, status: 'in_review' },
    })
    await expect
      .poll(async () => (await read()).assignment_history.at(-1)?.automation?.rule_id)
      .toBe(rule.id)
    const history = await read()
    const automated = history.assignment_history.at(-1)!
    expect(automated.by_user_id).toBe(user.id)
    expect(automated.automation?.rule_name).toBe(name)
    expect(automated.automation?.run_id).toBeTruthy()
    expect(history.status_history.at(-1)?.automation).toBeUndefined()

    await page.goto(path)
    await page.getByTestId(`cloud-todo-card-${issueId}`).click()
    await page.getByTestId('cloud-todo-more-properties').click()
    await page.getByTestId('cloud-todo-assignment-chain-trigger').click()
    const automatedRow = page
      .getByTestId('cloud-todo-assignment-chain-popover')
      .locator('.issue-assignment-history-route')
      .last()
    await expect(automatedRow.locator('span').first()).toHaveText(name)

    // Rename and disable the rule: historical attribution must retain its snapshot.
    await webApi(page, `${rulesPath}/${rule.id}`, {
      method: 'PATCH',
      body: {
        version: (await webApi<Resource[]>(page, rulesPath)).find(value => value.id === rule.id)!
          .version,
        name: `${name}-renamed`,
        enabled: false,
      },
    })
    await webApi(page, issuePath, {
      method: 'PATCH',
      body: {
        version: (await read()).version,
        assignee_user_id: Number(history.assignment_history[0].to_id),
      },
    })
    await page.reload()
    await expect(page.getByTestId('collaboration-issue-detail')).toBeVisible()
    await page.getByTestId('cloud-todo-more-properties').click()
    await page.getByTestId('cloud-todo-assignment-chain-trigger').click()
    const actors = page
      .getByTestId('cloud-todo-assignment-chain-popover')
      .locator('.issue-assignment-history-route > span:first-child')
    await expect(actors.filter({ hasText: name })).toHaveText(name)
    await expect(actors.last()).toHaveText(user.user_name)
    expect((await read()).assignment_history.at(-1)?.automation).toBeUndefined()
  }
)
