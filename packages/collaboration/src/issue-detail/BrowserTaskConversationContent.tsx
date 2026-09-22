import { RuntimeDeviceAccessBoundary } from '../conversation/RuntimeDeviceAccess'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationTranslate } from '../i18n'
import { TemporaryConversationLayout } from '../conversation/TemporaryConversationLayout'
import { ConversationTranslationProvider } from '../conversation/ConversationTranslation'
import { ScrollableMessageArea } from '../conversation/ScrollableMessageArea'
import { DESKTOP_MESSAGE_LIST_WIDTH_CLASS } from '../conversation/conversationLayout'
import { MarkdownServicesProvider } from '../markdown'
import { useBrowserRuntimeConversation } from './useBrowserRuntimeConversation'
import { BrowserTaskComposer } from './BrowserTaskComposer'

import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'

function BrowserTaskConversationContentContent({
  runtime,
  address,
  projectId,
  translate,
  preview = false,
  testId,
}: {
  runtime: SharedWorkspaceRuntimeApi
  address: RuntimeTaskAddress
  projectId: string
  translate: CollaborationTranslate
  preview?: boolean
  testId?: string
}) {
  const { state, session, task, markdown, conversation, metadataError, actionError, reload } =
    useBrowserRuntimeConversation(runtime, address, translate, projectId)
  return (
    <MarkdownServicesProvider value={markdown}>
      <ConversationTranslationProvider translate={translate}>
        {(state.error || metadataError || actionError) && (
          <div role="alert" className="px-4 py-2 text-xs text-error">
            {state.error || metadataError || actionError}
            {(state.error || metadataError) && (
              <button
                type="button"
                data-testid="task-conversation-retry"
                className="ml-2 underline"
                onClick={() => void reload()}
              >
                {translate('activity.retry')}
              </button>
            )}
          </div>
        )}
        <TemporaryConversationLayout
          messageCount={state.messages.length}
          loading={state.loading}
          loadError={state.error}
          onRetry={() => void reload()}
          emptyStateText={translate('activity.task_conversation_empty')}
          translate={translate}
          testId={testId}
          composer={
            <BrowserTaskComposer
              runtime={runtime}
              session={session}
              address={address}
              task={task}
              projectId={projectId}
              running={Boolean(state.running)}
              imageServices={conversation.userMessageServices.images}
              translate={translate}
              onAccepted={reload}
              collapseWhenIdle={preview}
            />
          }
        >
          <ScrollableMessageArea
            {...conversation}
            className="min-h-0 flex-1"
            scrollTestId="right-workspace-chat-scroll-area"
            scrollOrigin="bottom"
            initialScrollPosition={preview ? 'latest' : 'restore'}
            messageListClassName={`${DESKTOP_MESSAGE_LIST_WIDTH_CLASS} pb-4 pt-5`}
          />
        </TemporaryConversationLayout>
      </ConversationTranslationProvider>
    </MarkdownServicesProvider>
  )
}

export function BrowserTaskConversationContent(
  props: Parameters<typeof BrowserTaskConversationContentContent>[0]
) {
  if (props.address.projectSession) return <BrowserTaskConversationContentContent {...props} />
  return (
    <RuntimeDeviceAccessBoundary
      runtime={props.runtime}
      deviceId={props.address.deviceId}
      translate={props.translate}
    >
      <BrowserTaskConversationContentContent {...props} />
    </RuntimeDeviceAccessBoundary>
  )
}
