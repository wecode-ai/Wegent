import type { MessageListProps } from './MessageList'

export function areMessageListPropsEqual(
  previous: MessageListProps,
  next: MessageListProps
): boolean {
  const changed = [
    previous.userMessageServices !== next.userMessageServices ? 'userMessageServices' : null,
    previous.virtualize !== next.virtualize ? 'virtualize' : null,
    previous.useContentVisibility !== next.useContentVisibility ? 'useContentVisibility' : null,
    previous.onVirtualMeasurement !== next.onVirtualMeasurement ? 'onVirtualMeasurement' : null,
    previous.renderVisualization !== next.renderVisualization ? 'renderVisualization' : null,
    previous.messages !== next.messages ? 'messages' : null,
    previous.scrollElementRef !== next.scrollElementRef ? 'scrollElementRef' : null,
    previous.bottomOrigin !== next.bottomOrigin ? 'bottomOrigin' : null,
    previous.initialDistanceFromBottomPx !== next.initialDistanceFromBottomPx
      ? 'initialDistanceFromBottomPx'
      : null,
    previous.onBeforeUserMessageToggle !== next.onBeforeUserMessageToggle
      ? 'onBeforeUserMessageToggle'
      : null,
    previous.onVirtualLayoutChange !== next.onVirtualLayoutChange ? 'onVirtualLayoutChange' : null,
    previous.className !== next.className ? 'className' : null,
    previous.conversationKey !== next.conversationKey ? 'conversationKey' : null,
    previous.isWaitingForAssistant !== next.isWaitingForAssistant ? 'isWaitingForAssistant' : null,
    previous.disableContentVisibility !== next.disableContentVisibility
      ? 'disableContentVisibility'
      : null,
    previous.forceVirtualMessageId !== next.forceVirtualMessageId ? 'forceVirtualMessageId' : null,
    previous.devices !== next.devices ? 'devices' : null,
    previous.onRetryFailedMessage !== next.onRetryFailedMessage ? 'onRetryFailedMessage' : null,
    previous.onSwitchModelForFailedMessage !== next.onSwitchModelForFailedMessage
      ? 'onSwitchModelForFailedMessage'
      : null,
    previous.onLoadFileChangesDiff !== next.onLoadFileChangesDiff ? 'onLoadFileChangesDiff' : null,
    previous.onRevertFileChanges !== next.onRevertFileChanges ? 'onRevertFileChanges' : null,
    previous.onOpenFileChangesReview !== next.onOpenFileChangesReview
      ? 'onOpenFileChangesReview'
      : null,
    previous.fileChangesDiffPreviewDisabledSubtaskId !==
    next.fileChangesDiffPreviewDisabledSubtaskId
      ? 'fileChangesDiffPreviewDisabledSubtaskId'
      : null,
    previous.onOpenWorkspaceFile !== next.onOpenWorkspaceFile ? 'onOpenWorkspaceFile' : null,
    previous.onOpenLocalSkillFile !== next.onOpenLocalSkillFile ? 'onOpenLocalSkillFile' : null,
    previous.onRequestUserInputSubmit !== next.onRequestUserInputSubmit
      ? 'onRequestUserInputSubmit'
      : null,
    previous.onRequestUserInputIgnore !== next.onRequestUserInputIgnore
      ? 'onRequestUserInputIgnore'
      : null,
    previous.onOpenAssistantPlan !== next.onOpenAssistantPlan ? 'onOpenAssistantPlan' : null,
    previous.onOpenSubagent !== next.onOpenSubagent ? 'onOpenSubagent' : null,
    previous.onEditLastUserMessage !== next.onEditLastUserMessage ? 'onEditLastUserMessage' : null,
    previous.canEditLastUserMessage !== next.canEditLastUserMessage
      ? 'canEditLastUserMessage'
      : null,
    previous.onForkMessage !== next.onForkMessage ? 'onForkMessage' : null,
    previous.hideRequestUserInputBlocks !== next.hideRequestUserInputBlocks
      ? 'hideRequestUserInputBlocks'
      : null,
    previous.hiddenRequestUserInputIds !== next.hiddenRequestUserInputIds
      ? 'hiddenRequestUserInputIds'
      : null,
    previous.onAddSelectionToConversation !== next.onAddSelectionToConversation
      ? 'onAddSelectionToConversation'
      : null,
    previous.onAskSelectionInSidebar !== next.onAskSelectionInSidebar
      ? 'onAskSelectionInSidebar'
      : null,
    previous.virtualAnchorToEnd !== next.virtualAnchorToEnd ? 'virtualAnchorToEnd' : null,
    previous.renderGapAfterMessage !== next.renderGapAfterMessage ? 'renderGapAfterMessage' : null,
  ].filter((key): key is string => key !== null)

  return changed.length === 0
}
