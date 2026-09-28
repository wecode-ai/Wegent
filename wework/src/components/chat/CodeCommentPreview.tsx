import { getCodeCommentPreviewRightBoundary } from './conversationViewportBoundary'
import {
  CodeCommentPreview as SharedCodeCommentPreview,
  type CodeCommentPreviewProps,
} from '@wegent/collaboration/conversation'
import { DesktopConversationTranslation } from './DesktopConversationTranslation'

export function CodeCommentPreview(props: Omit<CodeCommentPreviewProps, 'getRightBoundary'>) {
  return (
    <DesktopConversationTranslation>
      <SharedCodeCommentPreview {...props} getRightBoundary={getCodeCommentPreviewRightBoundary} />
    </DesktopConversationTranslation>
  )
}
