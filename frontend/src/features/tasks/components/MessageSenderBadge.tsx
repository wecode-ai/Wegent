// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Enhanced MessageBubble wrapper for group chat support
 *
 * This component wraps the existing MessageBubble and adds sender information display
 * for group chat messages.
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
 * Wrapper component that adds sender information above messages in group chats
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

  // Don't show sender info if not a group chat
  if (!isGroupChat) {
    return <>{children}</>;
  }

  const isOwnMessage =
    subtask.sender_user_id === currentUserId || subtask.user_id === currentUserId;
  const senderName = subtask.sender_user_name || 'Unknown User';
  const isUserMessage = subtask.role === 'USER' || subtask.sender_type === 'USER';
  const isAIMessage = subtask.role === 'ASSISTANT' || subtask.sender_type === 'TEAM';

  // Determine message alignment based on sender
  const alignmentClass = isOwnMessage ? 'self-end' : 'self-start';

  return (
    <div className={`flex flex-col ${alignmentClass} max-w-[85%] sm:max-w-[80%]`}>
      {/* Show sender name for messages from other users */}
      {!isOwnMessage && isUserMessage && senderName && (
        <div className="text-xs text-text-muted mb-1 px-2 font-medium">{senderName}</div>
      )}

      {/* Show "AI (triggered by XXX)" for AI responses in group chat */}
      {isAIMessage && subtask.sender_user_name && (
        <div className="text-xs text-text-muted mb-1 px-2 flex items-center gap-1">
          <span className="text-base">🤖</span>
          <span>AI</span>
          <span className="text-text-secondary">(triggered by {subtask.sender_user_name})</span>
        </div>
      )}

      {/* Original message bubble */}
      {children}
    </div>
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

/**
 * Example usage in MessagesArea:
 *
 * ```tsx
 * import { GroupChatMessageWrapper, MessageSenderBadge } from './MessageSenderBadge'
 *
 * function MessagesArea({ subtasks, isGroupChat }) {
 *   const { user } = useUser()
 *
 *   return (
 *     <div className="messages-container">
 *       {subtasks.map(subtask => (
 *         // Option 1: Using wrapper
 *         <GroupChatMessageWrapper
 *           key={subtask.id}
 *           subtask={subtask}
 *           isGroupChat={isGroupChat}
 *         >
 *           <MessageBubble msg={convertToMessage(subtask)} ... />
 *         </GroupChatMessageWrapper>
 *
 *         // Option 2: Using inline badge
 *         <div key={subtask.id}>
 *           <MessageSenderBadge
 *             subtask={subtask}
 *             isGroupChat={isGroupChat}
 *             currentUserId={user?.id}
 *           />
 *           <MessageBubble msg={convertToMessage(subtask)} ... />
 *         </div>
 *       ))}
 *     </div>
 *   )
 * }
 * ```
 */
