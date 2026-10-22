// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { writeSharedComposer } from '../../utils/collaboration-test-support'
import { apiData, test, type ProjectMember } from '../../utils/project-mention-test-support'

// The chromium project in .github/workflows/e2e-tests.yml discovers this spec.
// All HTTP, WebSocket, database and inbox operations use the running services.
for (const scope of ['project', 'issue'] as const) {
  test.describe(`${scope} mention permissions`, () => {
    for (const mode of ['inherit', 'restricted'] as const) {
      test.describe(mode, () => {
        test.use({ membershipMode: mode })

        for (const [source, role] of [
          ['workspace', 'Developer'],
          ['workspace', 'Viewer'],
          ['workspace', 'Maintainer'],
          ['direct', 'Developer'],
          ['direct', 'Viewer'],
        ] as const) {
          test(`${source} ${role} follows the effective roster`, async ({ mentions }) => {
            await mentions.grant(source, role)
            const taskId = scope === 'issue' ? mentions.issue.id : undefined
            const allowed = source === 'direct' || mode === 'inherit' || role === 'Maintainer'
            const roster = await apiData(
              mentions.api.get<ProjectMember[]>(
                `/api/v1/cloud-projects/${mentions.project.id}/members`
              )
            )
            const member = roster.find(candidate => candidate.user_id === mentions.recipient.id)
            expect(Boolean(member)).toBe(allowed)
            if (allowed) {
              expect(member?.direct_role).toBe(source === 'direct' ? role : null)
              expect(member?.inherited_role).toBe(source === 'workspace' ? role : null)
            }
            const input = {
              projectId: mentions.project.id,
              taskId,
              clientMessageId: crypto.randomUUID(),
              text: `Roster mention ${crypto.randomUUID()}`,
              mentions: [mentions.mention],
            }

            if (allowed) {
              const message = await mentions.chat().send(input)
              expect((await mentions.messages(taskId)).map(row => row.messageId)).toEqual([
                message.messageId,
              ])
              expect(await mentions.inbox()).toEqual([
                expect.objectContaining({
                  kind: 'mention',
                  payload: expect.objectContaining({
                    projectId: mentions.project.id,
                    commentId: message.messageId,
                    ...(taskId ? { itemId: taskId } : {}),
                  }),
                }),
              ])
            } else {
              await expect(mentions.chat().send(input)).rejects.toThrow(
                'Mentioned user is not a project member'
              )
              expect(await mentions.messages(taskId)).toEqual([])
              expect(await mentions.inbox()).toEqual([])
            }
          })
        }
      })
    }

    for (const source of ['workspace', 'direct'] as const) {
      for (const invalid of ['revoked', 'inactive'] as const) {
        test(`rejects ${invalid} ${source} membership after loading the roster`, async ({
          mentions,
        }) => {
          await mentions.grant(source, 'Developer')
          const roster = await apiData(
            mentions.api.get<ProjectMember[]>(
              `/api/v1/cloud-projects/${mentions.project.id}/members`
            )
          )
          expect(roster.some(member => member.user_id === mentions.recipient.id)).toBe(true)
          if (invalid === 'revoked') {
            const path =
              source === 'workspace'
                ? `/api/v1/workspaces/${mentions.workspace.id}/members`
                : `/api/v1/cloud-projects/${mentions.project.id}/members`
            expect((await mentions.api.delete(`${path}/${mentions.recipient.id}`)).status).toBe(204)
          } else {
            await mentions.setActive(false)
          }
          const taskId = scope === 'issue' ? mentions.issue.id : undefined
          await expect(
            mentions.chat().send({
              projectId: mentions.project.id,
              taskId,
              clientMessageId: crypto.randomUUID(),
              text: 'Reject a stale picker selection',
              mentions: [mentions.mention],
            })
          ).rejects.toThrow('Mentioned user is not a project member')

          // Restore login eligibility only after the rejected write, then inspect the real inbox.
          if (invalid === 'inactive') await mentions.setActive(true)
          expect(await mentions.messages(taskId)).toEqual([])
          expect(await mentions.inbox()).toEqual([])
        })
      }
    }

    test('rejects a non-member without persisting a message or notification', async ({
      mentions,
    }) => {
      const taskId = scope === 'issue' ? mentions.issue.id : undefined
      await expect(
        mentions.chat().send({
          projectId: mentions.project.id,
          taskId,
          clientMessageId: crypto.randomUUID(),
          text: 'An outsider must not be mentioned',
          mentions: [mentions.mention],
        })
      ).rejects.toThrow('Mentioned user is not a project member')
      expect(await mentions.messages(taskId)).toEqual([])
      expect(await mentions.inbox()).toEqual([])
    })

    test('deduplicates recipients and retried sends, and suppresses self notifications', async ({
      mentions,
    }) => {
      await mentions.grant('workspace', 'Developer')
      const taskId = scope === 'issue' ? mentions.issue.id : undefined
      const client = mentions.chat()
      const received: string[] = []
      await client.subscribe(mentions.project.id, taskId, 0, message =>
        received.push(message.messageId)
      )
      const input = {
        projectId: mentions.project.id,
        taskId,
        clientMessageId: crypto.randomUUID(),
        text: `Duplicate mentions ${crypto.randomUUID()}`,
        mentions: [
          mentions.mention,
          mentions.mention,
          { type: 'user' as const, id: String(mentions.actor.id), label: mentions.actor.user_name },
        ],
      }
      const message = await client.send(input)
      expect((await client.send(input)).messageId).toBe(message.messageId)
      expect(received).toEqual([message.messageId])
      expect((await mentions.messages(taskId)).map(row => row.messageId)).toEqual([
        message.messageId,
      ])
      expect(await mentions.inbox()).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({ commentId: message.messageId }),
        }),
      ])
      expect(await mentions.inbox(mentions.api)).toEqual([])
    })
  })
}

test.describe('member-only comments with an unavailable assigned robot', () => {
  test.use({ assignedUnavailableAgent: true })

  test('selects an inherited member without executing the assigned robot and preserves the comment after refresh', async ({
    page,
    mentions,
  }) => {
    await mentions.grant('workspace', 'Developer')
    await page.goto(`${mentions.projectPath}/issues/${mentions.issue.id}`)
    const composer = page.getByTestId('collaboration-issue-comment')
    await writeSharedComposer(composer, '@')
    await page.getByTestId(`collaboration-issue-mention-member-${mentions.recipient.id}`).click()
    const text = `Inherited member browser mention ${crypto.randomUUID()}`
    await composer.pressSequentially(` ${text}`)
    await page.getByTestId('collaboration-issue-comment-submit').click()
    await expect(page.getByTestId('collaboration-comments')).toContainText(text)

    await page.reload()
    const card = page.locator('.task-detail-comment-card').filter({ hasText: text })
    await expect(card).toHaveCount(1)
    await expect(card).toContainText(mentions.recipient.user_name)
    const messages = await mentions.messages(mentions.issue.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toContain(text)
    expect(messages[0].metadata.execution_dispatch).toBe('comment_only')
    const client = mentions.chat()
    const executionRequest = {
      projectId: mentions.project.id,
      taskId: mentions.issue.id,
      triggerMessageId: messages[0].messageId,
      attachmentIds: [],
    }
    expect(await client.executeTaskComment(executionRequest)).toEqual([])
    expect(await client.executeTaskComment(executionRequest)).toEqual([])
    await expect(page.locator('.task-detail-comment-inline-error')).toHaveCount(0)
    expect(await mentions.inbox()).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ commentId: messages[0].messageId }),
      }),
    ])
  })
})

test.describe('Issue recipient visibility (CP14)', () => {
  test.use({ issueSecurity: 'related' })

  for (const source of ['workspace', 'direct'] as const) {
    for (const role of ['Developer', 'Viewer', 'Maintainer'] as const) {
      for (const related of [false, true]) {
        test(`${source} ${role}, related=${related}: authorizes comment and reply previews`, async ({
          mentions,
        }) => {
          await mentions.grant(source, role)
          if (related) {
            await apiData(
              mentions.api.post(`/api/v1/loop-items/${mentions.issue.id}/collaborators`, {
                user_id: mentions.recipient.id,
              })
            )
          }
          const detail = await mentions.recipientApi.get<{ can_view_detail: boolean }>(
            `/api/v1/loop-items/${mentions.issue.id}`
          )
          const allowed = related || role === 'Maintainer'
          expect(detail.status).toBe(allowed ? 200 : 404)
          if (allowed) expect(detail.data?.can_view_detail).toBe(true)
          const client = mentions.chat()
          const root = await client.send({
            projectId: mentions.project.id,
            taskId: mentions.issue.id,
            clientMessageId: crypto.randomUUID(),
            text: 'Confidential root preview',
          })
          const input = {
            projectId: mentions.project.id,
            taskId: mentions.issue.id,
            clientMessageId: crypto.randomUUID(),
            text: 'Confidential reply',
            replyToMessageId: root.messageId,
            mentions: [mentions.mention],
          }
          if (allowed) {
            const reply = await client.send(input)
            expect((await mentions.messages(mentions.issue.id)).map(row => row.messageId)).toEqual([
              root.messageId,
              reply.messageId,
            ])
            expect(await mentions.inbox()).toEqual([
              expect.objectContaining({
                payload: expect.objectContaining({ commentId: reply.messageId }),
              }),
            ])
          } else {
            await expect(client.send(input)).rejects.toThrow(
              'Mentioned user cannot view this issue'
            )
            expect((await mentions.messages(mentions.issue.id)).map(row => row.messageId)).toEqual([
              root.messageId,
            ])
            expect(await mentions.inbox()).toEqual([])
          }
        })
      }
    }
  }
})
