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
    actor_user_id: message.actorUserId,
    actor_display_name: message.actorDisplayName,
    generation_source: message.generationSource,
    publication_source: message.publicationSource,
    confirmation_state: message.confirmationState,
    trace_ref: message.traceRef,
    trace_state: message.traceState,
  }
}

/** Keep the existing comment port on its canonical Issue activity transport. */
export function createProjectChatComments(
  client: ProjectChatClient,
  issueProjectId: (issueId: string) => Promise<string>,
  publishActivity?: SharedWorkspaceApi['comments']['createAssistantPublication']
): SharedWorkspaceApi['comments'] {
  const publishAssistant: SharedWorkspaceApi['comments']['createAssistantPublication'] =
    publishActivity ??
    (client.publishAssistantMessage
      ? async (issueId, body, options) =>
          commentOf(
            await client.publishAssistantMessage!({
              projectId: options.projectId,
              taskId: issueId,
              clientMessageId: options.clientMessageId,
              text: body,
              source: options.assistantSource,
            })
          )
      : undefined)
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
          ...(options?.assistantSource ? { assistantSource: options.assistantSource } : {}),
        })
      )
    },
    ...(publishAssistant
      ? {
          createAssistantPublication(issueId, body, options) {
            return publishAssistant(issueId, body, options)
          },
        }
      : {}),
  }
}
