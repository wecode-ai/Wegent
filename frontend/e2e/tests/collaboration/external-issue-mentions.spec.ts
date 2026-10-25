// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { expect } from '@playwright/test'
import { apiData, test } from '../../utils/project-mention-test-support'

// Discovered by the chromium shards in .github/workflows/e2e-tests.yml.
// GitHub/GitLab HTTP is mocked explicitly, not a real provider integration.
// Wegent HTTP, WebSocket, membership, policy, database and inbox are real.
for (const provider of ['github', 'gitlab'] as const) {
  for (const localIndex of [false, true]) {
    test.describe(`${provider} mentions, local index=${localIndex}`, () => {
      test.use({ taskProvider: provider, localIssueIndex: localIndex, issueSecurity: 'related' })

      for (const operation of ['send', 'subscribe'] as const) {
        test(`rejects unrelated actors on ${operation}`, async ({ mentions }) => {
          // Developer isolates Issue visibility from project write permission.
          await mentions.grant('workspace', 'Developer')
          const detail = await mentions.recipientApi.get(`/api/v1/loop-items/${mentions.issue.id}`)
          expect(detail.status).toBe(404)
          const client = mentions.chat('recipient')
          const result =
            operation === 'send'
              ? client.send({
                  projectId: mentions.project.id,
                  taskId: mentions.issue.id,
                  clientMessageId: crypto.randomUUID(),
                  text: 'Unrelated actor must not write to a confidential Issue',
                })
              : client.subscribe(mentions.project.id, mentions.issue.id, 0, () => {})
          await expect(result).rejects.toThrow('TODO not found')
          expect(await mentions.messages(mentions.issue.id)).toEqual([])
          expect(await mentions.inbox()).toEqual([])
          expect(await mentions.inbox(mentions.api)).toEqual([])
        })
      }

      for (const reply of [false, true]) {
        test(`rejects unrelated recipients without writes, reply=${reply}`, async ({
          mentions,
        }) => {
          await mentions.grant('workspace', 'Viewer')
          const client = mentions.chat()
          const root = reply
            ? await client.send({
                projectId: mentions.project.id,
                taskId: mentions.issue.id,
                clientMessageId: crypto.randomUUID(),
                text: 'Confidential external root preview',
              })
            : undefined
          await expect(
            client.send({
              projectId: mentions.project.id,
              taskId: mentions.issue.id,
              clientMessageId: crypto.randomUUID(),
              text: 'Confidential mention preview',
              mentions: [mentions.mention],
              replyToMessageId: root?.messageId,
            })
          ).rejects.toThrow('Mentioned user cannot view this issue')
          expect(
            (await mentions.messages(mentions.issue.id)).map(message => message.messageId)
          ).toEqual(root ? [root.messageId] : [])
          expect(await mentions.inbox()).toEqual([])
        })

        for (const access of ['assignee', 'maintainer'] as const) {
          test(`notifies authorized ${access} exactly once, reply=${reply}`, async ({
            mentions,
          }) => {
            await mentions.grant('workspace', access === 'maintainer' ? 'Maintainer' : 'Viewer')
            if (!mentions.external) throw new Error('Expected the external HTTP fixture')
            if (access === 'assignee') mentions.external.setAssignee(mentions.recipient.id)
            const detail = await apiData(
              mentions.recipientApi.get<{ can_view_detail: boolean }>(
                `/api/v1/loop-items/${mentions.issue.id}`
              )
            )
            expect(detail.can_view_detail).toBe(true)
            const client = mentions.chat()
            const root = reply
              ? await client.send({
                  projectId: mentions.project.id,
                  taskId: mentions.issue.id,
                  clientMessageId: crypto.randomUUID(),
                  text: 'Authorized external root preview',
                })
              : undefined
            const input = {
              projectId: mentions.project.id,
              taskId: mentions.issue.id,
              clientMessageId: crypto.randomUUID(),
              text: 'Authorized external mention',
              replyToMessageId: root?.messageId,
              mentions: [mentions.mention, mentions.mention],
            }
            const message = await client.send(input)
            expect((await client.send(input)).messageId).toBe(message.messageId)
            const reader = await mentions
              .chat('recipient')
              .subscribe(mentions.project.id, mentions.issue.id, 0, () => {})
            expect(reader.snapshot.messages.map(row => row.messageId)).toEqual([
              ...(root ? [root.messageId] : []),
              message.messageId,
            ])
            expect((await mentions.messages(mentions.issue.id)).map(row => row.messageId)).toEqual(
              reader.snapshot.messages.map(row => row.messageId)
            )
            expect(await mentions.inbox()).toEqual([
              expect.objectContaining({
                kind: 'mention',
                payload: expect.objectContaining({
                  projectId: mentions.project.id,
                  itemId: mentions.issue.id,
                  itemTitle: 'External confidential Issue',
                  commentId: message.messageId,
                }),
              }),
            ])
            expect(await mentions.inbox(mentions.api)).toEqual([])
          })
        }
      }

      for (const operation of ['send', 'subscribe'] as const) {
        test(`rejects another project's task_id on ${operation}`, async ({ mentions }) => {
          if (!mentions.external) throw new Error('Expected the external HTTP fixture')
          const sibling = await mentions.external.createSiblingIssue()
          // The same actor can read both projects: only the scope mismatch denies access.
          const client = mentions.chat()
          expect(
            (await client.subscribe(sibling.project.id, sibling.issue.id, 0, () => {})).snapshot
              .messages
          ).toEqual([])
          const result =
            operation === 'send'
              ? client.send({
                  projectId: mentions.project.id,
                  taskId: sibling.issue.id,
                  clientMessageId: crypto.randomUUID(),
                  text: 'Cross-project write must not persist',
                })
              : client.subscribe(mentions.project.id, sibling.issue.id, 0, () => {})
          await expect(result).rejects.toThrow('Project task not found')
          expect(await mentions.messages(mentions.issue.id)).toEqual([])
          expect(
            (await mentions.chat().subscribe(sibling.project.id, sibling.issue.id, 0, () => {}))
              .snapshot.messages
          ).toEqual([])
          expect(await mentions.inbox()).toEqual([])
          expect(await mentions.inbox(mentions.api)).toEqual([])
        })
      }

      test('persists self mentions without notifying the sender', async ({ mentions }) => {
        const message = await mentions.chat().send({
          projectId: mentions.project.id,
          taskId: mentions.issue.id,
          clientMessageId: crypto.randomUUID(),
          text: 'External self mention',
          mentions: [
            { type: 'user', id: String(mentions.actor.id), label: mentions.actor.user_name },
          ],
        })
        expect((await mentions.messages(mentions.issue.id)).map(row => row.messageId)).toEqual([
          message.messageId,
        ])
        expect(await mentions.inbox(mentions.api)).toEqual([])
        expect(await mentions.inbox()).toEqual([])
      })
    })
  }
}
