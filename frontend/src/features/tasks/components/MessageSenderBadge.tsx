// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Sender information display components for group chat support
 *
 * These components add sender information display for group chat messages
 * without modifying the original MessageBubble layout.
 */

'use client';

import React from 'react';
import type { TaskDetailSubtask } from '@/types/api';
import { useUser } from '@/features/common/UserContext';

interface GroupChatMessageWrapperProps {
  subtask: TaskDetailSubtask;
  isGroupChat?: boolean;
  children: React.ReactNode;
}

/**
 * Lightweight wrapper that adds sender information above messages in group chats
 * without changing the original message layout structure.
 *
 * This component only renders a sender badge above the children when needed,
 * preserving the original MessageBubble's flex layout and alignment.
 *
 * Usage:
 * ```tsx
 * <GroupChatMessageWrapper subtask={subtask} isGroupChat={isGroupChat}>
 *   <MessageBubble {...props} />
 * </GroupChatMessageWrapper>
 * ```
 */
export function GroupChatMessageWrapper({
  subtask,
  isGroupChat,
  children,
}: GroupChatMessageWrapperProps) {
  const { user } = useUser();
  const currentUserId = user?.id;

  // Don't show sender info if not a group chat - just render children directly
  if (!isGroupChat) {
    return <>{children}</>;
  }

  const isOwnMessage =
    subtask.sender_user_id === currentUserId || subtask.user_id === currentUserId;
  const senderName = subtask.sender_user_name || 'Unknown User';
  const isUserMessage = subtask.role === 'USER' || subtask.sender_type === 'USER';
  const isAIMessage = subtask.role === 'ASSISTANT' || subtask.sender_type === 'TEAM';

  // Determine if we need to show any sender info
  const showUserSenderBadge = !isOwnMessage && isUserMessage && senderName;
  const showAISenderBadge = isAIMessage && subtask.sender_user_name;

  // If no sender badge needed, just render children directly
  if (!showUserSenderBadge && !showAISenderBadge) {
    return <>{children}</>;
  }

  // Render sender badge above the original message bubble
  // Using React.Fragment to avoid adding any wrapper div that could affect layout
  return (
    <>
      {/* Show sender name for messages from other users */}
      {showUserSenderBadge && (
        <div className="text-xs text-text-muted mb-1 font-medium">{senderName}</div>
      )}

      {/* Show "AI (triggered by XXX)" for AI responses in group chat */}
      {showAISenderBadge && (
        <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
          <span className="text-base">🤖</span>
          <span>AI</span>
          <span className="text-text-secondary">(triggered by {subtask.sender_user_name})</span>
        </div>
      )}

      {/* Original message bubble - rendered without any wrapper */}
      {children}
    </>
  );
}

/**
 * Alternative: Inline sender display component
 * Can be used directly in MessagesArea without wrapping
 */
export function MessageSenderBadge({
  subtask,
  isGroupChat,
  currentUserId,
}: {
  subtask: TaskDetailSubtask;
  isGroupChat?: boolean;
  currentUserId?: number;
}) {
  if (!isGroupChat) {
    return null;
  }

  const isOwnMessage =
    subtask.sender_user_id === currentUserId || subtask.user_id === currentUserId;
  const senderName = subtask.sender_user_name || 'Unknown User';
  const isUserMessage = subtask.role === 'USER' || subtask.sender_type === 'USER';
  const isAIMessage = subtask.role === 'ASSISTANT' || subtask.sender_type === 'TEAM';

  // Don't show badge for own messages
  if (isOwnMessage && isUserMessage) {
    return null;
  }

  // Show sender name for user messages from others
  if (!isOwnMessage && isUserMessage && senderName) {
    return <div className="text-xs text-text-muted mb-1 font-medium">{senderName}</div>;
  }

  // Show AI badge with trigger info
  if (isAIMessage && subtask.sender_user_name) {
    return (
      <div className="text-xs text-text-muted mb-1 flex items-center gap-1">
        <span className="text-base">🤖</span>
        <span>AI</span>
        <span className="text-text-secondary">(triggered by {subtask.sender_user_name})</span>
      </div>
    );
  }

  return null;
}
