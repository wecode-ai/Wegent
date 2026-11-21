// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { projectTest, type Resource } from '../../utils/collaboration-project-fixture'
import {
  selectCollaborationProjectView,
  showAllProjectIssues,
  webApi,
  writeSharedComposer,
} from '../../utils/collaboration-test-support'
import { REGULAR_USER } from '../../config/test-users'
import { buildStorageState, getJwtExpiryMs } from '../../utils/auth-state'
import { createApiClient } from '../../utils/api-client'
import type { ProjectChatMessage } from '../../../../packages/chat-core/src/project-chat'
import { connectChat } from '../../utils/project-mention-test-support'

for (const visibility of ['private', 'public'] as const) {
  projectTest(
    `invites and assigns an outsider with confirmation and revocable Issue-only management (${visibility})`,
    async (
      { page, request, browser, scheduledProject: { path, issueId: fixtureIssueId } },
      testInfo
    ) => {
      testInfo.setTimeout(120_000)
      const projectId = path.split('/').at(-1)!
      let issueId = fixtureIssueId
      const projectPath = `/api/v1/cloud-projects/${projectId}`
      if (visibility === 'public') {
        const project = await webApi<Resource>(page, projectPath)
        await webApi(page, projectPath, {
          method: 'PATCH',
          body: { version: project.version, visibility },
        })
        const created = await webApi<Resource>(page, `${projectPath}/loop-items`, {
          method: 'POST',
          body: { title: 'Owner-created shared Issue' },
        })
        issueId = created.id
      }
      const issuePath = `/api/v1/loop-items/${issueId}`
      const users = await webApi<{ users: Array<{ id: number; user_name: string }> }>(
        page,
        `/api/users/search?q=${encodeURIComponent(REGULAR_USER.username)}&limit=20`
      )
      const outsider = users.users.find(user => user.user_name === REGULAR_USER.username)!
      expect(outsider).toBeDefined()
      const initial = await webApi<Resource>(page, issuePath)
      await webApi(page, issuePath, {
        method: 'PATCH',
        body: { version: initial.version, assignee_user_id: null, security_level: 'related' },
      })
      await webApi(page, `${projectPath}/members/${outsider.id}`, { method: 'DELETE' })
      const sibling = await webApi<Resource>(page, `${projectPath}/loop-items`, {
        method: 'POST',
        body: { title: `Separately authorized child ${crypto.randomUUID()}`, parent_id: issueId },
      })
      await webApi(page, `/api/v1/loop-items/${sibling.id}`, {
        method: 'PATCH',
        body: { version: sibling.version, security_level: 'related' },
      })
      const guest = createApiClient(request)
      const login = await guest.login(REGULAR_USER.username, REGULAR_USER.password, 1)
      expect(login.status).toBe(200)
      const expectProjectAccess = async () => {
        if (visibility === 'private') expect((await guest.get(projectPath)).status).toBe(404)
        else {
          const publicProject = await guest.get<{
            access_role: string
            permission_sources: Array<{ type: string; role: string }>
          }>(projectPath)
          expect(publicProject.status).toBe(200)
          expect(publicProject.data!.access_role).toBe('Viewer')
          expect(publicProject.data!.permission_sources).toEqual([
            { type: 'public', role: 'Viewer' },
          ])
        }
      }
      expect((await guest.get(issuePath)).status).toBe(404)
      await page.goto(path)
      await showAllProjectIssues(page)
      await page.getByTestId(`cloud-todo-card-${issueId}`).click()
      await page.getByTestId('cloud-todo-detail-close').click()
      await expect(page.getByTestId('collaboration-issue-detail')).toHaveCount(0)
      await selectCollaborationProjectView(page, 'manage')
      await page.goto(`${path}/issues/${issueId}`)
      await page.getByTestId('cloud-todo-add-collaborator').click()
      const members = await webApi<Array<{ user_id: number; user_name: string }>>(
        page,
        `${projectPath}/members`
      )
      const owner = members.find(member => member.user_id !== outsider.id)!
      expect(owner).toBeDefined()
      await page.getByTestId(`cloud-todo-collaborator-option-${owner.user_id}`).click()
      const search = page.getByTestId('cloud-todo-collaborator-select')
      await expect(search).toHaveJSProperty('tagName', 'INPUT')
      await search.fill(outsider.user_name)
      const result = page.getByTestId(`cloud-todo-collaborator-option-${outsider.id}`)
      await expect(result).toContainText(/非项目成员|Outside this project/)
      await page.screenshot({
        path: testInfo.outputPath('outside-people-search.png'),
        fullPage: true,
      })
      await result.click()
      await page.getByTestId('cloud-todo-confirm-collaborator').click()
      await page.getByTestId('issue-outside-collaborator-cancel').click()
      expect((await guest.get(issuePath)).status).toBe(404)
      await page.getByTestId('cloud-todo-confirm-collaborator').click()
      await page.getByTestId('issue-outside-collaborator-confirm').click()
      await expect.poll(async () => (await guest.get(issuePath)).status).toBe(200)
      const ownerToken = (await page.context().cookies()).find(
        cookie => cookie.name === 'auth_token'
      )!.value
      const guestChat = connectChat(login.data!.access_token)
      const ownerChat = connectChat(ownerToken)
      const received: ProjectChatMessage[] = []
      const ownerReceived: ProjectChatMessage[] = []
      try {
        await guestChat.subscribe(projectId, issueId, 0, message => received.push(message))
        await ownerChat.subscribe(projectId, issueId, 0, message => ownerReceived.push(message))
        const invited = await guest.get<Resource & { invited_only: boolean }>(issuePath)
        expect(invited.data!.invited_only).toBe(true)
        expect((await guest.get(`${issuePath}/deliveries`)).status).toBe(200)
        await expectProjectAccess()
        expect((await guest.get(`/api/v1/loop-items/${sibling.id}`)).status).toBe(404)
        expect(
          (
            await guest.patch(issuePath, {
              version: invited.data!.version,
              title: 'Managed by invited participant',
            })
          ).status
        ).toBe(200)
        const guestContext = await browser.newContext({
          storageState: buildStorageState(
            new URL(page.url()).origin,
            login.data!.access_token,
            getJwtExpiryMs(login.data!.access_token)
          ),
        })
        try {
          const guestPage = await guestContext.newPage()
          if (visibility === 'private') {
            const sharePath = `/collaboration/${projectId}/issues/${issueId}`
            await guestPage.goto(sharePath)
            await expect(guestPage.getByTestId('cloud-todo-detail-title')).toBeVisible()
            await expect(guestPage).toHaveURL(new RegExp(`${sharePath}$`))
          }
          await guestPage.goto(page.url())
          await expect(
            guestPage
              .getByTestId('issue-primary-metadata')
              .getByTestId('cloud-todo-add-collaborator')
          ).toBeEnabled()
          await expect(guestPage.getByTestId('cloud-todo-detail-assignee')).toBeEnabled()
          const comment = `Invited participant comment ${crypto.randomUUID()}`
          await writeSharedComposer(guestPage.getByTestId('collaboration-issue-comment'), comment)
          await guestPage.getByTestId('collaboration-issue-comment-submit').click()
          await expect(guestPage.getByTestId('collaboration-comments')).toContainText(comment)
          await expect.poll(() => received.some(message => message.content === comment)).toBe(true)
          await guestPage.reload()
          await expect(guestPage.getByTestId('collaboration-comments')).toContainText(comment)
          await expect(
            guestPage.getByRole('button', {
              name: new RegExp(`移除参与者.*${outsider.user_name}|Remove.*${outsider.user_name}`),
            })
          ).toBeVisible()
          for (const testId of [
            'cloud-todo-detail-title',
            'cloud-todo-detail-close',
            'collaboration-issue-comment',
          ]) {
            await expect
              .poll(async () => {
                const bounds = await guestPage.getByTestId(testId).boundingBox()
                return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 1281)
              })
              .toBe(true)
          }
          await guestPage.screenshot({
            path: testInfo.outputPath('invited-issue-desktop.png'),
            fullPage: true,
          })
          await guestPage.setViewportSize({ width: 390, height: 844 })
          await expect(
            guestPage
              .getByTestId('issue-primary-metadata')
              .getByTestId('cloud-todo-add-collaborator')
          ).toBeVisible()
          expect(
            await guestPage.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth
            )
          ).toBe(true)
          for (const testId of [
            'cloud-todo-detail-title',
            'cloud-todo-detail-close',
            'collaboration-issue-comment',
          ]) {
            await expect
              .poll(async () => {
                const bounds = await guestPage.getByTestId(testId).boundingBox()
                return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391)
              })
              .toBe(true)
          }
          await guestPage.screenshot({
            path: testInfo.outputPath('invited-issue-mobile.png'),
            fullPage: true,
          })
          const current = await guest.get<Resource>(issuePath)
          expect(
            (
              await guest.post(`${projectPath}/loop-items/${issueId}/assign`, {
                version: current.data!.version,
                assignee_type: 'user',
                assignee_id: String(owner.user_id),
                notify_assignee: false,
              })
            ).status
          ).toBe(200)
          expect((await guest.delete(`${issuePath}/collaborators/${owner.user_id}`)).status).toBe(
            204
          )
          await guestPage.reload()
          await guestPage
            .getByTestId('issue-primary-metadata')
            .getByTestId('cloud-todo-add-collaborator')
            .click()
          await guestPage.getByTestId('cloud-todo-collaborator-select').fill(owner.user_name)
          await guestPage.getByTestId(`cloud-todo-collaborator-option-${owner.user_id}`).click()
          await guestPage.getByTestId('cloud-todo-confirm-collaborator').click()
          await guestPage.getByTestId('issue-outside-collaborator-confirm').click()
          await expect
            .poll(async () =>
              (
                await guest.get<Array<{ user_id: number }>>(`${issuePath}/collaborators`)
              ).data!.some(user => user.user_id === owner.user_id)
            )
            .toBe(true)
        } finally {
          await guestContext.close()
        }
        const childPath = `/api/v1/loop-items/${sibling.id}`
        await webApi(page, `${childPath}/collaborators`, {
          method: 'POST',
          body: { user_id: outsider.id },
        })
        expect((await guest.get(childPath)).status).toBe(200)
        await webApi(page, `${projectPath}/members`, {
          method: 'POST',
          body: { user_id: outsider.id, role: 'Developer' },
        })
        await guestChat.subscribe(projectId, issueId, 0, message => received.push(message))
        await webApi(page, `${projectPath}/members/${outsider.id}`, { method: 'DELETE' })
        expect((await guest.get(issuePath)).status).toBe(200)
        await page.reload()
        await page
          .getByRole('button', {
            name: new RegExp(`移除参与者.*${outsider.user_name}|Remove.*${outsider.user_name}`),
          })
          .click()
        await expect.poll(async () => (await guest.get(issuePath)).status).toBe(404)
        expect((await guest.get(childPath)).status).toBe(200)
        await webApi(page, `${childPath}/collaborators/${outsider.id}`, { method: 'DELETE' })
        expect((await guest.get(childPath)).status).toBe(404)
        const privateFollowup = 'After revocation ' + crypto.randomUUID()
        await ownerChat.send({
          projectId,
          taskId: issueId,
          clientMessageId: crypto.randomUUID(),
          text: privateFollowup,
        })
        await expect
          .poll(() => ownerReceived.some(message => message.content === privateFollowup))
          .toBe(true)
        await expect(
          guestChat.subscribe(projectId, issueId, 0, message => received.push(message))
        ).rejects.toThrow(/Cloud project not found|Project task not found/)
        expect(received.some(message => message.content === privateFollowup)).toBe(false)
        await expect(
          guestChat.send({
            projectId,
            taskId: issueId,
            clientMessageId: crypto.randomUUID(),
            text: 'No longer authorized',
          })
        ).rejects.toThrow(/Cloud project not found|Project task not found/)
        await page.getByTestId('cloud-todo-detail-assignee').click()
        await page.getByTestId('cloud-todo-detail-assignee-search').fill(outsider.user_name)
        await expect(
          page.getByTestId(`cloud-todo-detail-assignee-option-user:${outsider.id}`)
        ).toContainText(/非项目成员|Outside this project/)
        await page.getByTestId(`cloud-todo-detail-assignee-option-user:${outsider.id}`).click()
        await page.getByTestId('issue-outside-assignee-cancel').click()
        expect((await guest.get(issuePath)).status).toBe(404)
        await page.getByTestId('cloud-todo-detail-assignee').click()
        await page.getByTestId('cloud-todo-detail-assignee-search').fill(outsider.user_name)
        await page.getByTestId(`cloud-todo-detail-assignee-option-user:${outsider.id}`).click()
        await page.getByTestId('issue-outside-assignee-confirm').click()
        await expect.poll(async () => (await guest.get(issuePath)).status).toBe(200)
        await expectProjectAccess()
        await page.screenshot({ path: testInfo.outputPath('outside-assignee.png'), fullPage: true })
        await webApi(page, `${projectPath}/members`, {
          method: 'POST',
          body: { user_id: outsider.id, role: 'Viewer' },
        })
        const invitedViewer = await guest.get<Resource & { can_edit: boolean }>(issuePath)
        expect(invitedViewer.data!.can_edit).toBe(true)
        expect(
          (
            await guest.patch(issuePath, {
              version: invitedViewer.data!.version,
              title: 'Explicit Viewer manages this invited Issue',
            })
          ).status
        ).toBe(200)
        await guestChat.subscribe(projectId, issueId, 0, message => received.push(message))
        const viewerComment = `Invited explicit Viewer discussion ${crypto.randomUUID()}`
        await guestChat.send({
          projectId,
          taskId: issueId,
          clientMessageId: crypto.randomUUID(),
          text: viewerComment,
        })
        await expect
          .poll(() => ownerReceived.some(message => message.content === viewerComment))
          .toBe(true)
        await page.reload()
        await page.getByTestId('cloud-todo-detail-assignee').click()
        await page.getByTestId('cloud-todo-detail-assignee-option-empty').click()
        if (visibility === 'private') {
          await expect
            .poll(
              async () =>
                (await guest.get<Resource & { can_edit: boolean }>(issuePath)).data?.can_edit
            )
            .toBe(false)
          const restored = await guest.get<Resource>(issuePath)
          expect(restored.status).toBe(200)
          expect(restored.data).toMatchObject({
            created_by_user_id: outsider.id,
            assignee_user_id: null,
            invited_only: false,
            permissions: { edit_content: false, comment: false, assign: false, execute: false },
          })
          expect(
            (
              await guest.patch(issuePath, {
                version: restored.data!.version,
                title: 'Former invitee cannot edit',
              })
            ).status
          ).toBe(403)
        } else {
          await expect.poll(async () => (await guest.get(issuePath)).status).toBe(404)
        }
        const restoredViewer = await guest.get<{ access_role: string }>(projectPath)
        expect(restoredViewer.data!.access_role).toBe('Viewer')
        await webApi(page, `${projectPath}/members/${outsider.id}`, { method: 'DELETE' })
        expect((await guest.get(issuePath)).status).toBe(404)
      } finally {
        guestChat.dispose()
        ownerChat.dispose()
      }
    }
  )
}
