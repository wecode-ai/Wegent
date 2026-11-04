// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import { webApi } from '../../utils/collaboration-test-support'
import { sleep } from '../../utils/helpers'

interface StatusRule extends Resource {
  prompt: string
  enabled: boolean
  eventType: string
  eventConfig: {
    statuses: string[]
    transition: string
    execution_target: string
  }
  targetKind: string
  targetId: string
}

interface StatusRun {
  id: string
  status: string
  taskId: string
  eventType: string
}

interface IncomingHook {
  id: string
  sourceType: string
  collectionMode: string
}

interface StatusEvent {
  id: string
  status: string
  normalizedEvents: Array<{ event_type: string; subject: { id: string } }>
}

projectTest(
  'persists a target status and triggers only when an enabled rule enters that status',
  async ({ page, scheduledProject: { path, issueId } }) => {
    const prompt = '进入目标状态后检查交付物。\n保留中文、多行和 `code` 格式。'
    const updatedPrompt = '复核完成后整理结论。\n说明发现的问题与验证结果。'
    const projectId = path.split('/').at(-1)!
    const rulesPath = `/api/v1/cloud-projects/${projectId}/automations`
    const issuePath = `/api/v1/loop-items/${issueId}`
    await page.goto(`${path}?view=manage`)
    await page.getByTestId('collaboration-project-settings-automatic-processing').click()
    await page.getByTestId('automatic-processing-create').click()
    await page.getByTestId('automatic-processing-trigger-status_changed').locator('..').click()
    await expect(page.getByTestId('automatic-processing-trigger-status_changed')).toBeChecked()
    await page.getByTestId('automatic-processing-status').selectOption('in_review')
    await page.getByTestId('automatic-processing-prompt').fill(prompt)
    await page.getByTestId('automatic-processing-target-kind-human').click()
    await expect(page.getByTestId('automatic-processing-target-kind-human')).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    const created = page.waitForResponse(
      response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === rulesPath
    )
    await page.getByTestId('automatic-processing-save').click()
    const createResponse = await created
    expect(createResponse.ok(), await createResponse.text()).toBe(true)
    const rule = (await createResponse.json()) as StatusRule
    const ruleRow = page.getByTestId(`automatic-processing-rule-${rule.id}`)
    const readRule = async () => {
      const rules = await webApi<StatusRule[]>(page, rulesPath)
      return rules.find(candidate => candidate.id === rule.id)!
    }
    expect(await readRule()).toMatchObject({
      prompt,
      eventType: 'task.status_changed',
      eventConfig: {
        statuses: ['in_review'],
        transition: 'any',
        execution_target: 'existing_issue',
      },
      targetKind: 'human',
    })

    await page.reload()
    await page.getByTestId('collaboration-project-settings-automatic-processing').click()
    await page.getByTestId(`automatic-processing-edit-${rule.id}`).click()
    await expect(page.getByTestId('automatic-processing-status')).toHaveValue('in_review')
    await expect(page.getByTestId('automatic-processing-prompt')).toHaveValue(prompt)
    await page.getByTestId('automatic-processing-status').selectOption('completed')
    await page.getByTestId('automatic-processing-prompt').fill(updatedPrompt)
    const updated = page.waitForResponse(
      response =>
        response.request().method() === 'PATCH' &&
        new URL(response.url()).pathname === `${rulesPath}/${rule.id}`
    )
    await page.getByTestId('automatic-processing-save').click()
    const updateResponse = await updated
    expect(updateResponse.ok(), await updateResponse.text()).toBe(true)
    expect((await readRule()).eventConfig.statuses).toEqual(['completed'])
    expect((await readRule()).prompt).toBe(updatedPrompt)
    await expect(ruleRow).toContainText(/已完成|Completed/)
    await page.reload()
    await page.getByTestId('collaboration-project-settings-automatic-processing').click()
    await page.getByTestId(`automatic-processing-edit-${rule.id}`).click()
    await expect(page.getByTestId('automatic-processing-status')).toHaveValue('completed')
    await expect(page.getByTestId('automatic-processing-prompt')).toHaveValue(updatedPrompt)
    await page.getByTestId('automatic-processing-cancel').click()

    const runsPath = `${rulesPath}/${rule.id}/runs`
    const runs = () => webApi<StatusRun[]>(page, runsPath)
    const statusEvents = async () => {
      const hooksPath = `/api/v1/cloud-projects/${projectId}/incoming-hooks`
      const hooks = await webApi<IncomingHook[]>(page, hooksPath)
      const internalHooks = hooks.filter(
        hook => hook.sourceType === 'wework' && hook.collectionMode === 'internal'
      )
      const events = await Promise.all(
        internalHooks.map(hook =>
          webApi<StatusEvent[]>(page, `${hooksPath}/${hook.id}/events?limit=200`)
        )
      )
      return events
        .flat()
        .filter(event =>
          event.normalizedEvents.some(
            normalized =>
              normalized.event_type === 'task.status_changed' && normalized.subject.id === issueId
          )
        )
    }
    let settledEvents = await statusEvents()
    const changeStatus = async (status: string) => {
      const before = await statusEvents()
      expect(before.map(event => event.id).sort()).toEqual(
        settledEvents.map(event => event.id).sort()
      )
      expect(before.map(event => event.status)).toEqual(before.map(() => 'processed'))
      const previousIds = new Set(before.map(event => event.id))
      const current = await webApi<Resource & { status: string }>(page, issuePath)
      await webApi(page, issuePath, {
        method: 'PATCH',
        body: { version: current.version, status },
      })
      if (current.status !== status) {
        // PATCH may return after the background poller claims this event. Wait
        // for that exact transition to finish before changing the Issue again.
        let transitionEvents: StatusEvent[] = []
        await expect
          .poll(
            async () => {
              transitionEvents = (await statusEvents()).filter(event => !previousIds.has(event.id))
              return transitionEvents.map(event => event.status)
            },
            { message: `The ${current.status} → ${status} event must finish processing` }
          )
          .toEqual(['processed'])
        settledEvents = [...before, ...transitionEvents]
        expect(await webApi(page, issuePath)).toMatchObject({ status })
      } else {
        expect((await statusEvents()).map(event => event.id).sort()).toEqual(
          [...previousIds].sort()
        )
      }
    }
    const expectRunsUnchanged = async (expected: StatusRun[]) => {
      expect(settledEvents.map(event => event.status)).toEqual(settledEvents.map(() => 'processed'))
      const eventIds = settledEvents.map(event => event.id).sort()
      const deadline = Date.now() + 1000
      // Assert every sample throughout the window; an unexpected run or event
      // fails immediately rather than being retried until it disappears.
      do {
        const [observedRuns, observedEvents] = await Promise.all([runs(), statusEvents()])
        expect(observedRuns.map(run => run.id)).toEqual(expected.map(run => run.id))
        expect(observedEvents.map(event => event.id).sort()).toEqual(eventIds)
        expect(observedEvents.map(event => event.status)).toEqual(
          observedEvents.map(() => 'processed')
        )
        if (Date.now() >= deadline) break
        await sleep(100)
      } while (true)
    }
    const enabled = page.getByTestId(`automatic-processing-enabled-${rule.id}`)
    await enabled.click()
    await expect.poll(async () => (await readRule()).enabled).toBe(false)
    expect((await readRule()).prompt).toBe(updatedPrompt)
    await changeStatus('completed')
    await expectRunsUnchanged([])
    expect(await runs()).toEqual([])
    await enabled.click()
    await expect.poll(async () => (await readRule()).enabled).toBe(true)
    expect((await readRule()).eventConfig.statuses).toEqual(['completed'])
    expect((await readRule()).prompt).toBe(updatedPrompt)
    await expectRunsUnchanged([])
    expect(await runs()).toEqual([])

    await changeStatus('completed')
    await expectRunsUnchanged([])
    expect(await runs()).toEqual([])
    await changeStatus('in_review')
    await expectRunsUnchanged([])
    expect(await runs()).toEqual([])
    await changeStatus('completed')
    await expect.poll(runs).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        taskId: issueId,
        eventType: 'task.status_changed',
      }),
    ])
    const firstRuns = await runs()
    expect(firstRuns).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        taskId: issueId,
        eventType: 'task.status_changed',
      }),
    ])
    expect(await webApi(page, issuePath)).toMatchObject({
      assignee_user_id: Number(rule.targetId),
      status: 'completed',
    })
    await changeStatus('completed')
    await expectRunsUnchanged(firstRuns)
    expect((await runs()).map(run => run.id)).toEqual(firstRuns.map(run => run.id))
    await changeStatus('inbox')
    await expectRunsUnchanged(firstRuns)
    expect((await runs()).map(run => run.id)).toEqual(firstRuns.map(run => run.id))
    await changeStatus('completed')
    await expect.poll(runs).toEqual([
      expect.objectContaining({
        status: 'succeeded',
        taskId: issueId,
        eventType: 'task.status_changed',
      }),
      expect.objectContaining({
        status: 'succeeded',
        taskId: issueId,
        eventType: 'task.status_changed',
      }),
    ])
    const repeatedRuns = await runs()
    expect(repeatedRuns).toHaveLength(2)
    expect(new Set(repeatedRuns.map(run => run.id)).size).toBe(2)
    expect(repeatedRuns.every(run => run.status === 'succeeded' && run.taskId === issueId)).toBe(
      true
    )
    await expectRunsUnchanged(repeatedRuns)
  }
)
