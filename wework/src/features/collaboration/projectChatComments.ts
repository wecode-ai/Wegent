import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { SharedWorkspaceApi } from '@wegent/collaboration'

function commentOf(message: ProjectChatMessage) {
  return {
    id: message.messageId,
    body: message.content,
    author: message.sender.name,
    web_url: null,
    created_at: message.createdAt,
    updated_at: message.updatedAt,
  }
}

/** Keep the existing comment port on its canonical Issue activity transport. */
export function createProjectChatComments(
  client: ProjectChatClient,
  issueProjectId: (issueId: string) => Promise<string>
): SharedWorkspaceApi['comments'] {
  return {
    async list(issueId) {
      const { snapshot, unsubscribe } = await client.subscribe(
        await issueProjectId(issueId),
        issueId,
        0,
        () => undefined
      )
      unsubscribe()
      return snapshot.messages.map(commentOf)
    },
    async create(issueId, body, options) {
      return commentOf(
        await client.send({
          projectId: await issueProjectId(issueId),
          taskId: issueId,
          clientMessageId: options?.clientMessageId ?? crypto.randomUUID(),
          text: body,
        })
      )
    },
  }
}
