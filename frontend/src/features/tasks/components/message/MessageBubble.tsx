// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { memo, useState } from 'react';
import type { TaskDetail, Team, GitRepoInfo, GitBranch, Attachment } from '@/types/api';
import {
  Bot,
  Download,
  AlertCircle,
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  Ban,
  User,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import MarkdownEditor from '@uiw/react-markdown-editor';
import MarkdownWithMermaid from '@/components/common/MarkdownWithMermaid';
import { ThinkingDisplay } from './thinking';
import ClarificationForm from '../clarification/ClarificationForm';
import FinalPromptMessage from './FinalPromptMessage';
import ClarificationAnswerSummary from '../clarification/ClarificationAnswerSummary';
import AttachmentPreview from '../input/AttachmentPreview';
import StreamingWaitIndicator from './StreamingWaitIndicator';
import BubbleTools, { CopyButton } from './BubbleTools';
import { SourceReferences } from '../chat/SourceReferences';
import type { ClarificationData, FinalPromptData, ClarificationAnswer } from '@/types/api';
import type { SourceReference } from '@/types/socket';
import { useTraceAction } from '@/hooks/useTraceAction';
import { useMessageFeedback } from '@/hooks/useMessageFeedback';
import { SmartLink, SmartImage, SmartTextLine } from '@/components/common/SmartUrlRenderer';
export interface Message {
  type: 'user' | 'ai';
  content: string;
  timestamp: number;
  botName?: string;
  subtaskStatus?: string;
  subtaskId?: number;
  thinking?: Array<{
    title: string;
    next_action: string;
    details?: Record<string, unknown>;
    action?: string;
    result?: string;
    reasoning?: string;
    confidence?: number;
    value?: unknown;
  }> | null;
  /** Full result data from backend (for code executor with workbench, or chat with shell_type) */
  result?: {
    value?: string;
    thinking?: unknown[];
    workbench?: Record<string, unknown>;
    shell_type?: string; // Shell type (Chat, ClaudeCode, Agno, etc.)
    sources?: SourceReference[]; // RAG knowledge base sources
  };
  attachments?: Attachment[];
  /** Recovered content from Redis/DB when user refreshes during streaming */
  recoveredContent?: string;
  /** Flag indicating this message has recovered content */
  isRecovered?: boolean;
  /** Flag indicating the content is incomplete (client disconnected) */
  isIncomplete?: boolean;
  /** Flag indicating this message is waiting for first character (streaming but no content yet) */
  isWaiting?: boolean;
  /** Group chat: sender user name (for USER type messages) */
  senderUserName?: string;
  /** Group chat: sender user ID (for determining message alignment) */
  senderUserId?: number;
  /** Whether this is a group chat or chat agent type (to show sender names) */
  shouldShowSender?: boolean;
  /** Message status: pending, streaming, completed, error */
  status?: 'pending' | 'streaming' | 'completed' | 'error';
  /** Error message if status is 'error' */
  error?: string;
  /** RAG knowledge base sources (top-level for backward compatibility) */
  sources?: SourceReference[];
}

/** Configuration for paragraph-level action button */
export interface ParagraphAction {
  /** Icon to display on hover */
  icon: React.ReactNode;
  /** Tooltip text for the action button */
  tooltip?: string;
  /** Callback when action is triggered - receives paragraph text and optional click event */
  onAction: (paragraphText: string, event?: React.MouseEvent) => void;
  /** Optional: Render a popover content instead of just calling onAction */
  renderPopover?: (props: { paragraphText: string; onClose: () => void }) => React.ReactNode;
}

export interface MessageBubbleProps {
  msg: Message;
  index: number;
  selectedTaskDetail: TaskDetail | null;
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  theme: 'light' | 'dark';
  t: (key: string) => string;
  /** Whether to show waiting indicator (streaming but no content yet) */
  isWaiting?: boolean;
  /** Generic callback when a component inside the message bubble wants to send a message (e.g., ClarificationForm) */
  onSendMessage?: (content: string) => void;
  /** Callback when user selects text in AI message (optional) - receives selected text */
  onTextSelect?: (selectedText: string) => void;
  /** Paragraph-level action configuration - shows action button on hover for each paragraph in AI messages */
  paragraphAction?: ParagraphAction;
  /**
   * Whether this message is from the current user (for group chat alignment).
   * In group chat, only current user's messages should be right-aligned.
   * Other users' messages should be left-aligned like AI messages.
   * If not provided, defaults to true for user messages (backward compatible).
   */
  isCurrentUserMessage?: boolean;
  /** Callback when user clicks retry button for failed messages */
  onRetry?: (message: Message) => void;
  /** Message type for feedback storage key differentiation */
  feedbackMessageType?: 'original' | 'correction';
}

// Component for rendering a paragraph with hover action button
const ParagraphWithAction = ({
  children,
  paragraphText,
  action,
}: {
  children: React.ReactNode;
  paragraphText: string;
  action: ParagraphAction;
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);

  const handleAction = (e: React.MouseEvent) => {
    e.stopPropagation();
    // If renderPopover is provided, the Popover will handle the action
    // Otherwise, call onAction directly with the event for positioning
    if (!action.renderPopover) {
      action.onAction(paragraphText, e);
    }
  };

  const handleClosePopover = () => {
    setIsPopoverOpen(false);
  };

  // Render the action button
  const renderActionButton = () => {
    const button = (
      <Button
        variant="ghost"
        size="icon"
        onClick={handleAction}
        className="h-7 w-7 hover:bg-primary/10 hover:text-primary"
        title={action.tooltip}
      >
        {action.icon}
      </Button>
    );

    // If renderPopover is provided, wrap button in Popover
    if (action.renderPopover) {
      return (
        <Popover open={isPopoverOpen} onOpenChange={setIsPopoverOpen}>
          <PopoverTrigger asChild>{button}</PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            className="w-80 p-0 bg-surface border-border"
            onInteractOutside={() => setIsPopoverOpen(false)}
          >
            {action.renderPopover({
              paragraphText,
              onClose: handleClosePopover,
            })}
          </PopoverContent>
        </Popover>
      );
    }

    // Otherwise, just show tooltip if provided
    if (action.tooltip) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="right">{action.tooltip}</TooltipContent>
        </Tooltip>
      );
    }

    return button;
  };

  return (
    <div
      className="relative group/paragraph"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {children}
      {/* Action button - appears on hover at the right side */}
      <div
        className={`absolute -right-8 top-0 transition-opacity duration-200 ${
          isHovered || isPopoverOpen ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {renderActionButton()}
      </div>
    </div>
  );
};

const MessageBubble = memo(
  function MessageBubble({
    msg,
    index,
    selectedTaskDetail,
    selectedTeam,
    selectedRepo,
    selectedBranch,
    theme,
    t,
    isWaiting,
    onSendMessage,
    onTextSelect,
    paragraphAction,
    isCurrentUserMessage,
    onRetry,
    feedbackMessageType,
  }: MessageBubbleProps) {
    // Use trace hook for telemetry (auto-includes user and task context)
    const { trace } = useTraceAction();

    // Use feedback hook for managing like/dislike state with localStorage persistence
    const { feedback, handleLike, handleDislike } = useMessageFeedback({
      subtaskId: msg.subtaskId,
      timestamp: msg.timestamp,
      messageType: feedbackMessageType,
      onFeedbackChange: fb =>
        trace.event('message-feedback', {
          'feedback.type': fb ?? 'cancelled',
          'feedback.message_type': msg.type,
          'feedback.category': feedbackMessageType || 'original',
          ...(msg.subtaskId && { 'subtask.id': msg.subtaskId }),
        }),
    });

    // Determine if this is a user-type message (for styling purposes)
    const isUserTypeMessage = msg.type === 'user';

    // Determine if this message should be right-aligned (current user's message)
    // For group chat: only current user's messages are right-aligned
    // For non-group chat (backward compatible): all user messages are right-aligned
    // Default to true for user messages if isCurrentUserMessage is not provided
    const shouldAlignRight = isUserTypeMessage && (isCurrentUserMessage ?? true);

    const bubbleBaseClasses = `relative w-full p-5 text-text-primary ${isUserTypeMessage ? 'overflow-visible' : 'pb-10'}`;
    const bubbleTypeClasses = isUserTypeMessage
      ? 'group rounded-2xl border border-border bg-surface shadow-sm'
      : '';

    const formatTimestamp = (timestamp: number | undefined) => {
      if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return '';
      return new Date(timestamp).toLocaleTimeString(navigator.language, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
    };

    const timestampLabel = formatTimestamp(msg.timestamp);
    const headerIcon = isUserTypeMessage ? null : msg.botName === t('correction.result_title') ? (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="lucide lucide-circle-check-big h-4 w-4 text-primary"
        aria-hidden="true"
      >
        <path d="M21.801 10A10 10 0 1 1 17 3.335"></path>
        <path d="m9 11 3 3L22 4"></path>
      </svg>
    ) : (
      <Bot className="w-4 h-4" />
    );
    const headerLabel = isUserTypeMessage ? '' : msg.botName || t('messages.bot') || 'Bot';

    // Determine if message is currently streaming (to disable URL metadata fetching)
    // During streaming, we show simple links to avoid excessive API calls
    const isStreaming =
      msg.subtaskStatus === 'RUNNING' ||
      msg.subtaskStatus === 'PENDING' ||
      msg.subtaskStatus === 'PROCESSING' ||
      isWaiting ||
      msg.isWaiting;

    const renderProgressBar = (status: string, progress: number) => {
      const normalizedStatus = (status ?? '').toUpperCase();
      const isActiveStatus = ['RUNNING', 'PENDING', 'PROCESSING'].includes(normalizedStatus);
      const safeProgress = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 100) : 0;

      // Get status configuration (icon, label key, colors)
      const getStatusConfig = (statusKey: string) => {
        switch (statusKey) {
          case 'RUNNING':
            return {
              icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
              labelKey: 'messages.status_running',
              bgClass: 'bg-primary/10',
              textClass: 'text-primary',
              dotClass: 'bg-primary',
            };
          case 'PENDING':
            return {
              icon: <Clock className="h-3.5 w-3.5" />,
              labelKey: 'messages.status_pending',
              bgClass: 'bg-amber-500/10',
              textClass: 'text-amber-600 dark:text-amber-400',
              dotClass: 'bg-amber-500',
            };
          case 'PROCESSING':
            return {
              icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
              labelKey: 'messages.status_processing',
              bgClass: 'bg-blue-500/10',
              textClass: 'text-blue-600 dark:text-blue-400',
              dotClass: 'bg-blue-500',
            };
          case 'COMPLETED':
            return {
              icon: <CheckCircle2 className="h-3.5 w-3.5" />,
              labelKey: 'messages.status_completed',
              bgClass: 'bg-green-500/10',
              textClass: 'text-green-600 dark:text-green-400',
              dotClass: 'bg-green-500',
            };
          case 'FAILED':
            return {
              icon: <XCircle className="h-3.5 w-3.5" />,
              labelKey: 'messages.status_failed',
              bgClass: 'bg-red-500/10',
              textClass: 'text-red-600 dark:text-red-400',
              dotClass: 'bg-red-500',
            };
          case 'CANCELLED':
            return {
              icon: <Ban className="h-3.5 w-3.5" />,
              labelKey: 'messages.status_cancelled',
              bgClass: 'bg-gray-500/10',
              textClass: 'text-gray-600 dark:text-gray-400',
              dotClass: 'bg-gray-500',
            };
          case 'CANCELLING':
            return {
              icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
              labelKey: 'messages.status_cancelling',
              bgClass: 'bg-orange-500/10',
              textClass: 'text-orange-600 dark:text-orange-400',
              dotClass: 'bg-orange-500',
            };
          default:
            return {
              icon: <Loader2 className="h-3.5 w-3.5" />,
              labelKey: 'messages.status_running',
              bgClass: 'bg-primary/10',
              textClass: 'text-primary',
              dotClass: 'bg-primary',
            };
        }
      };

      const config = getStatusConfig(normalizedStatus);

      return (
        <div className="mt-3 space-y-2">
          {/* Status Badge */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${config.bgClass} ${config.textClass}`}
            >
              {config.icon}
              <span>{t(config.labelKey) || status}</span>
            </span>
          </div>

          {/* Minimal Progress Bar - only show for active statuses */}
          {isActiveStatus && (
            <div className="w-full bg-border/40 rounded-full h-1 overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${config.dotClass} ${isActiveStatus ? 'progress-bar-shimmer' : ''}`}
                style={{ width: `${Math.max(safeProgress, 3)}%` }}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={safeProgress}
                role="progressbar"
              />
            </div>
          )}
        </div>
      );
    };

    const renderMarkdownResult = (rawResult: string, promptPart?: string) => {
      const trimmed = (rawResult ?? '').trim();
      const fencedMatch = trimmed.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/);
      let normalizedResult = fencedMatch ? fencedMatch[1] : trimmed;

      // Pre-process markdown to handle edge cases where ** is followed by punctuation
      // Markdown parsers don't recognize **'text'** or **text**。 as bold
      // Convert these patterns to HTML <strong> tags for proper rendering
      normalizedResult = normalizedResult.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      const progressMatch = normalizedResult.match(/^__PROGRESS_BAR__:(.*?):(\d+)$/);
      if (progressMatch) {
        const status = progressMatch[1];
        const progress = parseInt(progressMatch[2], 10) || 0;
        return renderProgressBar(status, progress);
      }

      // Helper to extract text content from React children
      const extractText = (node: React.ReactNode): string => {
        if (typeof node === 'string') return node;
        if (typeof node === 'number') return String(node);
        if (Array.isArray(node)) return node.map(extractText).join('');
        if (React.isValidElement(node)) {
          const props = node.props as { children?: React.ReactNode };
          if (props.children) {
            return extractText(props.children);
          }
        }
        return '';
      };

      // Helper to wrap content with paragraph action
      const wrapWithAction = (element: React.ReactNode, text: string) => {
        if (!paragraphAction || !text.trim()) return element;
        return (
          <ParagraphWithAction paragraphText={text} action={paragraphAction}>
            {element}
          </ParagraphWithAction>
        );
      };

      return (
        <>
          <MarkdownWithMermaid
            source={normalizedResult}
            theme={theme}
            components={
              paragraphAction
                ? {
                    a: ({ href, children }) => {
                      if (!href) {
                        return <span>{children}</span>;
                      }
                      return (
                        <SmartLink href={href} disabled={isStreaming}>
                          {children}
                        </SmartLink>
                      );
                    },
                    img: ({ src, alt }) => {
                      if (!src || typeof src !== 'string') return null;
                      return <SmartImage src={src} alt={alt} />;
                    },
                    p: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<p>{children}</p>, text);
                    },
                    h1: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h1>{children}</h1>, text);
                    },
                    h2: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h2>{children}</h2>, text);
                    },
                    h3: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h3>{children}</h3>, text);
                    },
                    h4: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h4>{children}</h4>, text);
                    },
                    h5: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h5>{children}</h5>, text);
                    },
                    h6: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<h6>{children}</h6>, text);
                    },
                    li: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<li>{children}</li>, text);
                    },
                    blockquote: ({ children }) => {
                      const text = extractText(children);
                      return wrapWithAction(<blockquote>{children}</blockquote>, text);
                    },
                  }
                : {
                    a: ({ href, children }) => {
                      if (!href) {
                        return <span>{children}</span>;
                      }
                      return (
                        <SmartLink href={href} disabled={isStreaming}>
                          {children}
                        </SmartLink>
                      );
                    },
                    img: ({ src, alt }) => {
                      if (!src || typeof src !== 'string') return null;
                      return <SmartImage src={src} alt={alt} />;
                    },
                  }
            }
          />
          <SourceReferences sources={msg.sources || msg.result?.sources || []} />
          <BubbleTools
            contentToCopy={`${promptPart ? promptPart + '\n\n' : ''}${normalizedResult}`}
            onCopySuccess={() => trace.copy(msg.type, msg.subtaskId)}
            tools={[
              {
                key: 'download',
                title: t('messages.download') || 'Download',
                icon: <Download className="h-4 w-4 text-text-muted" />,
                onClick: () => {
                  const blob = new Blob([`${normalizedResult}`], {
                    type: 'text/plain;charset=utf-8',
                  });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'message.md';
                  a.click();
                  URL.revokeObjectURL(url);
                  trace.download(msg.type, msg.subtaskId);
                },
              },
            ]}
            feedback={feedback}
            onLike={handleLike}
            onDislike={handleDislike}
            feedbackLabels={{
              like: t('chat:messages.like') || 'Like',
              dislike: t('chat:messages.dislike') || 'Dislike',
            }}
          />
        </>
      );
    };

    const renderPlainMessage = (message: Message) => {
      // Check if this is an external API params message
      if (message.type === 'user' && message.content.includes('[EXTERNAL_API_PARAMS]')) {
        const paramsMatch = message.content.match(
          /\[EXTERNAL_API_PARAMS\]([\s\S]*?)\[\/EXTERNAL_API_PARAMS\]/
        );
        if (paramsMatch) {
          try {
            const params = JSON.parse(paramsMatch[1]);
            const remainingContent = message.content
              .replace(/\[EXTERNAL_API_PARAMS\][\s\S]*?\[\/EXTERNAL_API_PARAMS\]\n?/, '')
              .trim();

            return (
              <div className="space-y-3">
                <div className="bg-base-secondary rounded-lg p-3 border border-border">
                  <div className="text-xs font-semibold text-text-muted mb-2">
                    📋 {t('messages.application_parameters') || '应用参数'}
                  </div>
                  <div className="space-y-2">
                    {Object.entries(params).map(([key, value]) => (
                      <div key={key} className="flex items-start gap-2">
                        <span className="text-xs font-medium text-text-secondary min-w-[80px]">
                          {key}:
                        </span>
                        <span className="text-xs text-text-primary flex-1 break-all">
                          {String(value)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
                {remainingContent && <div className="text-sm break-all">{remainingContent}</div>}
              </div>
            );
          } catch (e) {
            console.error('Failed to parse EXTERNAL_API_PARAMS:', e);
          }
        }
      }

      // Check if this is a Markdown clarification answer (user message)
      if (message.type === 'user' && message.content.includes('## 📝 我的回答')) {
        const answerPayload: ClarificationAnswer[] = [];
        const questionRegex = /### ([A-Z_\d]+): (.*?)\n\*\*Answer\*\*: ([\s\S]*?)(?=\n###|$)/g;
        let match;

        while ((match = questionRegex.exec(message.content)) !== null) {
          const questionId = match[1].toLowerCase();
          const questionText = match[2].trim();
          const answerContent = match[3].trim();

          if (answerContent.startsWith('-')) {
            const optionRegex = /- `([^`]+)` - (.*?)(?=\n-|$)/g;
            const values: string[] = [];
            const labels: string[] = [];
            let optMatch;

            while ((optMatch = optionRegex.exec(answerContent)) !== null) {
              values.push(optMatch[1]);
              labels.push(optMatch[2].trim());
            }

            answerPayload.push({
              question_id: questionId,
              question_text: questionText,
              answer_type: 'choice',
              value: values,
              selected_labels: labels,
            });
          } else if (answerContent.startsWith('`')) {
            const singleMatch = answerContent.match(/`([^`]+)` - (.*)/);
            if (singleMatch) {
              answerPayload.push({
                question_id: questionId,
                question_text: questionText,
                answer_type: 'choice',
                value: singleMatch[1],
                selected_labels: singleMatch[2].trim(),
              });
            }
          } else {
            answerPayload.push({
              question_id: questionId,
              question_text: questionText,
              answer_type: 'custom',
              value: answerContent,
            });
          }
        }

        if (answerPayload.length > 0) {
          return (
            <ClarificationAnswerSummary
              data={{ type: 'clarification_answer', answers: answerPayload }}
              rawContent={message.content}
            />
          );
        }
      }

      return (message.content?.split('\n') || []).map((line, idx) => {
        if (line.startsWith('__PROMPT_TRUNCATED__:')) {
          const lineMatch = line.match(/^__PROMPT_TRUNCATED__:(.*)::(.*)$/);
          if (lineMatch) {
            const shortPrompt = lineMatch[1];
            const fullPrompt = lineMatch[2];
            return (
              <span
                key={idx}
                className="text-sm font-bold cursor-pointer underline decoration-dotted block"
                title={fullPrompt}
              >
                {shortPrompt}
              </span>
            );
          }
        }

        const progressMatch = line.match(/__PROGRESS_BAR__:(.*?):(\d+)/);
        if (progressMatch) {
          const status = progressMatch[1];
          const progress = parseInt(progressMatch[2], 10) || 0;
          return <React.Fragment key={idx}>{renderProgressBar(status, progress)}</React.Fragment>;
        }

        // Use SmartTextLine to detect and render URLs (images and links) in plain text
        // Pass disabled={isStreaming} to avoid metadata fetching during streaming
        return <SmartTextLine key={idx} text={line} disabled={isStreaming} />;
      });
    };
    // Helper function to parse Markdown clarification questions
    // Supports flexible formats: with/without code blocks, emoji variations, different header levels
    // Extracts content between the header and the last ``` (or end of content if no valid closing ```)
    // Returns: { data: ClarificationData, prefixText: string, suffixText: string } | null
    const parseMarkdownClarification = (
      content: string
    ): { data: ClarificationData; prefixText: string; suffixText: string } | null => {
      // Flexible header detection for clarification questions
      // Two regex patterns to support both old and new formats:
      // Old format: ## 💬 智能追问 (Smart Follow-up Questions)
      // New format: ## 🤔 需求澄清问题 (Clarification Questions)
      const smartFollowUpRegex =
        /#{1,6}\s*(?:💬\s*)?(?:智能追问|smart\s*follow[- ]?up(?:\s*questions?)?)/im;
      const clarificationQuestionsRegex =
        /#{1,6}\s*(?:🤔\s*)?(?:需求)?(?:澄清问题?|clarification\s*questions?)/im;

      // Try both patterns
      const smartFollowUpMatch = content.match(smartFollowUpRegex);
      const clarificationMatch = content.match(clarificationQuestionsRegex);

      // Use the first match found (prefer the one that appears earlier in content)
      let headerMatch: RegExpMatchArray | null = null;
      if (smartFollowUpMatch && clarificationMatch) {
        // Both matched, use the one that appears first
        headerMatch =
          smartFollowUpMatch.index! <= clarificationMatch.index!
            ? smartFollowUpMatch
            : clarificationMatch;
      } else {
        headerMatch = smartFollowUpMatch || clarificationMatch;
      }

      if (!headerMatch) {
        return null;
      }

      // Find the position of the header and extract everything from the header onwards
      const headerIndex = headerMatch.index!;
      const prefixText = content.substring(0, headerIndex).trim();
      let actualContent = content.substring(headerIndex);
      let suffixText = '';

      // Find the last ``` in the content
      const lastCodeBlockMarkerIndex = actualContent.lastIndexOf('\n```');

      if (lastCodeBlockMarkerIndex !== -1) {
        // Check if the last ``` is within 2 lines of the actual end
        const contentAfterMarker = actualContent.substring(lastCodeBlockMarkerIndex + 4); // +4 for '\n```'
        const linesAfterMarker = contentAfterMarker.split('\n').filter(line => line.trim() !== '');

        if (linesAfterMarker.length <= 2) {
          // Valid closing ```, extract content before it and save content after as potential suffix
          const potentialSuffix = contentAfterMarker.trim();
          actualContent = actualContent.substring(0, lastCodeBlockMarkerIndex).trim();
          // If there's content after the closing ```, save it as suffix
          if (potentialSuffix) {
            suffixText = potentialSuffix;
          }
        }
        // If the ``` is too far from the end, keep the full content
      }

      const questions: ClarificationData['questions'] = [];

      // Flexible question header detection
      // Matches: ### Q1:, ### Q1：, **Q1:**, Q1:, Q1., 1., 1:, etc.
      const questionRegex =
        /(?:^|\n)(?:#{1,6}\s*)?(?:\*\*)?Q?(\d+)(?:\*\*)?[:.：]\s*(.*?)(?=\n(?:#{1,6}\s*)?(?:\*\*)?(?:Q?\d+|Type|类型)|\n\*\*(?:Type|类型)\*\*|$)/gi;
      const matches = Array.from(actualContent.matchAll(questionRegex));

      // Track the end position of the last successfully parsed question
      let lastParsedEndIndex = 0;

      for (const match of matches) {
        try {
          const questionNumber = parseInt(match[1]);
          const questionText = match[2].trim();

          if (!questionText) continue;

          // Find the question block (from current match to next question or end)
          const startIndex = match.index!;
          const nextQuestionMatch = actualContent
            .substring(startIndex + match[0].length)
            .match(/\n(?:#{1,6}\s*)?(?:\*\*)?Q?\d+[:.：]/i);
          const endIndex = nextQuestionMatch
            ? startIndex + match[0].length + nextQuestionMatch.index!
            : actualContent.length;
          const questionBlock = actualContent.substring(startIndex, endIndex);

          // Flexible type detection
          // Matches: **Type**: value, Type: value, **类型**: value, 类型: value
          const typeMatch = questionBlock.match(/(?:\*\*)?(?:Type|类型)(?:\*\*)?[:\s：]+\s*(\w+)/i);
          if (!typeMatch) continue;

          const typeValue = typeMatch[1].toLowerCase();
          let questionType: 'single_choice' | 'multiple_choice' | 'text_input';

          if (typeValue.includes('single') || typeValue === 'single_choice') {
            questionType = 'single_choice';
          } else if (typeValue.includes('multi') || typeValue === 'multiple_choice') {
            questionType = 'multiple_choice';
          } else if (typeValue.includes('text') || typeValue === 'text_input') {
            questionType = 'text_input';
          } else {
            questionType = 'single_choice'; // default fallback
          }

          const questionId = `q${questionNumber}`;

          if (questionType === 'text_input') {
            questions.push({
              question_id: questionId,
              question_text: questionText,
              question_type: 'text_input',
            });
            lastParsedEndIndex = endIndex;
          } else {
            const options: ClarificationData['questions'][0]['options'] = [];
            // Track the end position of the last option within this question block
            let lastOptionEndInBlock = 0;

            // Flexible option detection
            // Matches: - [✓] `value` - Label, - [x] value - Label, - [ ] `value` - Label, - `value` - Label
            // The lookahead matches: next option line, bold text, header, empty line, or end of string
            const optionRegex =
              /- \[([✓xX* ]?)\]\s*`?([^`\n-]+)`?\s*-\s*([^\n]*)(?=\n-|\n\*\*|\n#{1,6}|\n\n|\n?$)/g;
            let optionMatch;

            while ((optionMatch = optionRegex.exec(questionBlock)) !== null) {
              const checkMark = optionMatch[1].trim();
              const isRecommended =
                checkMark === '✓' || checkMark.toLowerCase() === 'x' || checkMark === '*';
              const value = optionMatch[2].trim();
              const label = optionMatch[3]
                .trim()
                .replace(/\s*\((?:recommended|推荐)\)\s*$/i, '')
                .trim();

              if (value) {
                options.push({
                  value,
                  label: label || value,
                  recommended: isRecommended,
                });
                // Update the end position of the last option
                lastOptionEndInBlock = optionMatch.index + optionMatch[0].length;
              }
            }

            // Fallback: try simpler option format without checkbox
            // Matches: - `value` - Label, - value - Label
            if (options.length === 0) {
              const simpleOptionRegex =
                /-\s*`?([^`\n-]+)`?\s*-\s*([^\n]*)(?=\n-|\n\*\*|\n#{1,6}|\n\n|\n?$)/g;
              let simpleMatch;

              while ((simpleMatch = simpleOptionRegex.exec(questionBlock)) !== null) {
                const value = simpleMatch[1].trim();
                const label = simpleMatch[2]
                  .trim()
                  .replace(/\s*\((?:recommended|推荐)\)\s*$/i, '')
                  .trim();
                const isRecommended =
                  simpleMatch[2].toLowerCase().includes('recommended') ||
                  simpleMatch[2].includes('推荐');

                if (value && !value.startsWith('[')) {
                  options.push({
                    value,
                    label: label || value,
                    recommended: isRecommended,
                  });
                  // Update the end position of the last option
                  lastOptionEndInBlock = simpleMatch.index + simpleMatch[0].length;
                }
              }
            }

            if (options.length > 0) {
              questions.push({
                question_id: questionId,
                question_text: questionText,
                question_type: questionType,
                options,
              });
              // Use the actual end position of the last option, not the entire question block
              // This allows us to capture any text after the last option as suffix
              lastParsedEndIndex = startIndex + lastOptionEndInBlock;
            }
          }
        } catch {
          // Continue parsing other questions even if one fails
          continue;
        }
      }

      if (questions.length === 0) return null;

      // Extract suffix text: content after the last successfully parsed question
      // Only extract from actualContent if we haven't already extracted suffix from after the code block
      if (!suffixText && lastParsedEndIndex > 0 && lastParsedEndIndex < actualContent.length) {
        const extractedSuffix = actualContent.substring(lastParsedEndIndex).trim();
        // Clean up suffix text: remove leading closing code block markers if present
        const cleanedSuffix = extractedSuffix.replace(/^```\s*\n?/, '').trim();
        if (cleanedSuffix) {
          suffixText = cleanedSuffix;
        }
      }

      return {
        data: {
          type: 'clarification',
          questions,
        },
        prefixText,
        suffixText,
      };
    };

    // Helper function to parse Markdown final prompt
    // Supports flexible formats: with/without code blocks, emoji variations, different header levels
    // Extracts content between the header and the last ``` (or end of content if no valid closing ```)
    const parseMarkdownFinalPrompt = (content: string): FinalPromptData | null => {
      // Flexible header detection for final prompt
      // Matches: ## ✅ 最终需求提示词, ## Final Requirement Prompt, ### 最终提示词, # final prompt, etc.
      const finalPromptHeaderRegex =
        /#{1,6}\s*(?:✅\s*)?(?:最终(?:需求)?提示词|final\s*(?:requirement\s*)?prompt)/im;
      const headerMatch = content.match(finalPromptHeaderRegex);
      if (!headerMatch) {
        return null;
      }

      // Find the position of the header and extract everything from the header line onwards
      const headerIndex = headerMatch.index!;
      const contentFromHeader = content.substring(headerIndex);

      // Find the end of the header line
      const headerLineEndIndex = contentFromHeader.indexOf('\n');
      if (headerLineEndIndex === -1) {
        // Header is the only line, no content after it
        return null;
      }

      // Get content after the header line
      const afterHeader = contentFromHeader.substring(headerLineEndIndex + 1);

      // Find the last ``` in the content
      const lastCodeBlockMarkerIndex = afterHeader.lastIndexOf('\n```');

      let promptContent: string;

      if (lastCodeBlockMarkerIndex !== -1) {
        // Check if the last ``` is within 2 lines of the actual end
        const contentAfterMarker = afterHeader.substring(lastCodeBlockMarkerIndex + 4); // +4 for '\n```'
        const linesAfterMarker = contentAfterMarker.split('\n').filter(line => line.trim() !== '');

        if (linesAfterMarker.length <= 2) {
          // Valid closing ```, extract content before it
          promptContent = afterHeader.substring(0, lastCodeBlockMarkerIndex).trim();
        } else {
          // The ``` is too far from the end, model probably didn't output proper closing
          // Take everything to the end
          promptContent = afterHeader.trim();
        }
      } else {
        // No closing ``` found, take everything to the end
        promptContent = afterHeader.trim();
      }

      if (!promptContent) {
        return null;
      }

      return {
        type: 'final_prompt',
        final_prompt: promptContent,
      };
    };
    const renderAiMessage = (message: Message, messageIndex: number) => {
      const content = message.content ?? '';

      try {
        let contentToParse = content;

        if (content.includes('${$$}$')) {
          const [, result] = content.split('${$$}$');
          if (result) {
            contentToParse = result;
          }
        }
        const markdownClarification = parseMarkdownClarification(contentToParse);
        if (markdownClarification) {
          const { data, prefixText, suffixText } = markdownClarification;
          return (
            <div className="space-y-4">
              {/* Render prefix text (content before the clarification form) */}
              {prefixText && (
                <MarkdownEditor.Markdown
                  source={prefixText}
                  style={{ background: 'transparent' }}
                  wrapperElement={{ 'data-color-mode': theme }}
                  components={{
                    a: ({ href, children }) => {
                      if (!href) {
                        return <span>{children}</span>;
                      }
                      return (
                        <SmartLink href={href} disabled={isStreaming}>
                          {children}
                        </SmartLink>
                      );
                    },
                    img: ({ src, alt }) => {
                      if (!src || typeof src !== 'string') return null;
                      return <SmartImage src={src} alt={alt} />;
                    },
                  }}
                />
              )}
              {/* Render the clarification form */}
              <ClarificationForm
                data={data}
                taskId={selectedTaskDetail?.id || 0}
                currentMessageIndex={messageIndex}
                rawContent={contentToParse}
                onSubmit={onSendMessage}
              />
              {/* Render suffix text (content after the clarification form that couldn't be parsed) */}
              {suffixText && (
                <div className="mt-4 p-3 rounded-lg border border-border bg-surface/50">
                  <MarkdownEditor.Markdown
                    source={suffixText}
                    style={{ background: 'transparent' }}
                    wrapperElement={{ 'data-color-mode': theme }}
                    components={{
                      a: ({ href, children }) => {
                        if (!href) {
                          return <span>{children}</span>;
                        }
                        return (
                          <SmartLink href={href} disabled={isStreaming}>
                            {children}
                          </SmartLink>
                        );
                      },
                      img: ({ src, alt }) => {
                        if (!src || typeof src !== 'string') return null;
                        return <SmartImage src={src} alt={alt} />;
                      },
                    }}
                  />
                </div>
              )}
            </div>
          );
        }

        const markdownFinalPrompt = parseMarkdownFinalPrompt(contentToParse);
        if (markdownFinalPrompt) {
          return (
            <FinalPromptMessage
              data={markdownFinalPrompt}
              selectedTeam={selectedTeam}
              selectedRepo={selectedRepo}
              selectedBranch={selectedBranch}
            />
          );
        }
      } catch (error) {
        console.error('Failed to parse message content:', error);
      }

      if (!content.includes('${$$}$')) {
        // Render AI message as markdown by default
        return renderMarkdownResult(content);
      }

      const [prompt, result] = content.split('${$$}$');
      return (
        <>
          {prompt && <div className="text-sm whitespace-pre-line mb-2">{prompt}</div>}
          {result && renderMarkdownResult(result, prompt)}
        </>
      );
    };

    const renderMessageBody = (message: Message, messageIndex: number) =>
      message.type === 'ai' ? renderAiMessage(message, messageIndex) : renderPlainMessage(message);

    const renderAttachments = (attachments?: Attachment[]) => {
      if (!attachments || attachments.length === 0) return null;

      return (
        <div className="flex flex-wrap gap-2 mb-3">
          {attachments.map((attachment, idx) => (
            <AttachmentPreview
              key={`attachment-${attachment.id}-${idx}`}
              attachment={attachment}
              compact={false}
              showDownload={true}
            />
          ))}
        </div>
      );
    };

    // Render recovered content notice
    const renderRecoveryNotice = () => {
      if (!msg.isRecovered) return null;

      return (
        <div className="bg-muted border-l-4 border-primary p-3 mt-2 rounded-r-lg">
          <div className="flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-primary mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary">
                {msg.isIncomplete
                  ? t('messages.content_incomplete') || '回答未完成'
                  : t('messages.content_recovered') || '已恢复内容'}
              </p>
              <p className="text-xs text-text-muted mt-1">
                {msg.isIncomplete
                  ? t('messages.content_incomplete_desc') || '连接已断开，这是生成的部分内容'
                  : t('messages.content_recovered_desc') || '页面刷新后已恢复之前的内容'}
              </p>
            </div>
          </div>
        </div>
      );
    };

    // Render recovered content with typewriter effect (content is already processed by RecoveredMessageBubble)
    // Also handles clarification form parsing for streaming content
    const renderRecoveredContent = () => {
      if (!msg.recoveredContent || msg.subtaskStatus !== 'RUNNING') return null;

      // Pre-process markdown to handle edge cases where ** is followed by punctuation
      // Same fix as in renderMarkdownResult - convert all ** to <strong> tags
      const contentToRender = msg.recoveredContent.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      // Try to parse clarification format from recovered/streaming content
      // This ensures clarification forms are rendered correctly during streaming
      const markdownClarification = parseMarkdownClarification(contentToRender);
      if (markdownClarification) {
        const { data, prefixText, suffixText } = markdownClarification;
        return (
          <div className="space-y-4">
            {/* Render prefix text (content before the clarification form) */}
            {prefixText && (
              <MarkdownEditor.Markdown
                source={prefixText}
                style={{ background: 'transparent' }}
                wrapperElement={{ 'data-color-mode': theme }}
                components={{
                  a: ({ href, children }) => {
                    if (!href) {
                      return <span>{children}</span>;
                    }
                    return (
                      <SmartLink href={href} disabled={isStreaming}>
                        {children}
                      </SmartLink>
                    );
                  },
                  img: ({ src, alt }) => {
                    if (!src || typeof src !== 'string') return null;
                    return <SmartImage src={src} alt={alt} />;
                  },
                }}
              />
            )}
            {/* Render the clarification form */}
            <ClarificationForm
              data={data}
              taskId={selectedTaskDetail?.id || 0}
              currentMessageIndex={index}
              rawContent={contentToRender}
              onSubmit={onSendMessage}
            />
            {/* Render suffix text (content after the clarification form that couldn't be parsed) */}
            {suffixText && (
              <div className="mt-4 p-3 rounded-lg border border-border bg-surface/50">
                <MarkdownEditor.Markdown
                  source={suffixText}
                  style={{ background: 'transparent' }}
                  wrapperElement={{ 'data-color-mode': theme }}
                  components={{
                    a: ({ href, children }) => {
                      if (!href) {
                        return <span>{children}</span>;
                      }
                      return (
                        <SmartLink href={href} disabled={isStreaming}>
                          {children}
                        </SmartLink>
                      );
                    },
                    img: ({ src, alt }) => {
                      if (!src || typeof src !== 'string') return null;
                      return <SmartImage src={src} alt={alt} />;
                    },
                  }}
                />
              </div>
            )}
            {/* Show copy and download buttons */}
            <SourceReferences sources={msg.sources || msg.result?.sources || []} />
            <BubbleTools
              contentToCopy={contentToRender}
              onCopySuccess={() => trace.copy(msg.type, msg.subtaskId)}
              tools={[
                {
                  key: 'download',
                  title: t('messages.download') || 'Download',
                  icon: <Download className="h-4 w-4 text-text-muted" />,
                  onClick: () => {
                    const blob = new Blob([contentToRender], {
                      type: 'text/plain;charset=utf-8',
                    });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = 'message.md';
                    a.click();
                    URL.revokeObjectURL(url);
                    trace.download(msg.type, msg.subtaskId);
                  },
                },
              ]}
              feedback={feedback}
              onLike={handleLike}
              onDislike={handleDislike}
              feedbackLabels={{
                like: t('messages.like') || 'Like',
                dislike: t('messages.dislike') || 'Dislike',
              }}
            />
          </div>
        );
      }

      // Try to parse final prompt format
      const markdownFinalPrompt = parseMarkdownFinalPrompt(contentToRender);
      if (markdownFinalPrompt) {
        return (
          <FinalPromptMessage
            data={markdownFinalPrompt}
            selectedTeam={selectedTeam}
            selectedRepo={selectedRepo}
            selectedBranch={selectedBranch}
          />
        );
      }

      // Default: render as markdown
      return (
        <div className="space-y-2">
          {contentToRender ? (
            <>
              <MarkdownWithMermaid
                source={contentToRender}
                theme={theme}
                components={{
                  a: ({ href, children }) => {
                    if (!href) {
                      return <span>{children}</span>;
                    }
                    return (
                      <SmartLink href={href} disabled={isStreaming}>
                        {children}
                      </SmartLink>
                    );
                  },
                  img: ({ src, alt }) => {
                    if (!src || typeof src !== 'string') return null;
                    return <SmartImage src={src} alt={alt} />;
                  },
                }}
              />
              {/* Show copy and download buttons during streaming */}
              <SourceReferences sources={msg.sources || msg.result?.sources || []} />
              <BubbleTools
                contentToCopy={contentToRender}
                onCopySuccess={() => trace.copy(msg.type, msg.subtaskId)}
                tools={[
                  {
                    key: 'download',
                    title: t('messages.download') || 'Download',
                    icon: <Download className="h-4 w-4 text-text-muted" />,
                    onClick: () => {
                      const blob = new Blob([contentToRender], {
                        type: 'text/plain;charset=utf-8',
                      });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = 'message.md';
                      a.click();
                      URL.revokeObjectURL(url);
                      trace.download(msg.type, msg.subtaskId);
                    },
                  },
                ]}
                feedback={feedback}
                onLike={handleLike}
                onDislike={handleDislike}
                feedbackLabels={{
                  like: t('messages.like') || 'Like',
                  dislike: t('messages.dislike') || 'Dislike',
                }}
              />
            </>
          ) : (
            <div className="flex items-center gap-2 text-text-muted">
              <span className="animate-pulse">●</span>
              <span className="text-sm">{t('messages.thinking') || 'Thinking...'}</span>
            </div>
          )}
        </div>
      );
    };

    // Handle text selection in AI messages
    const handleTextSelection = () => {
      if (!onTextSelect || isUserTypeMessage) return;

      const selection = window.getSelection();
      if (selection && selection.toString().trim()) {
        const selectedText = selection.toString().trim();
        onTextSelect(selectedText);
      }
    };

    // DEBUG: Log shell_type check
    if (msg.thinking) {
      console.log('[MessageBubble] Checking shell_type:', {
        subtaskId: msg.subtaskId,
        hasResult: !!msg.result,
        shell_type: msg.result?.shell_type,
        isChat: msg.result?.shell_type === 'Chat',
      });
    }

    return (
      <div className={`flex ${shouldAlignRight ? 'justify-end' : 'justify-start'}`} translate="no">
        <div
          className={`flex ${shouldAlignRight ? 'max-w-[75%] w-auto' : isUserTypeMessage ? 'max-w-[75%] w-auto' : 'w-full'} flex-col ${shouldAlignRight ? 'items-end' : 'items-start'}`}
        >
          {/* Show thinking display for AI messages */}
          {!isUserTypeMessage && msg.thinking && (
            <ThinkingDisplay
              thinking={msg.thinking}
              taskStatus={msg.subtaskStatus}
              shellType={msg.result?.shell_type}
            />
          )}
          <div
            className={`${bubbleBaseClasses} ${bubbleTypeClasses}`}
            onMouseUp={handleTextSelection}
          >
            {/* Show header for AI messages */}
            {!isUserTypeMessage && (
              <div className="flex items-center gap-2 mb-2 text-xs opacity-80">
                {headerIcon}
                <span className="font-semibold">{headerLabel}</span>
                {timestampLabel && <span>{timestampLabel}</span>}
                {msg.isRecovered && (
                  <span className="text-primary text-xs">
                    ({t('messages.recovered') || '已恢复'})
                  </span>
                )}
              </div>
            )}
            {/* Show header for other users' messages in group chat (left-aligned user messages) */}
            {isUserTypeMessage && !shouldAlignRight && msg.shouldShowSender && (
              <div className="flex items-center gap-2 mb-2 text-xs opacity-80">
                <User className="w-4 h-4" />
                <span className="font-semibold">{msg.senderUserName || 'Unknown User'}</span>
                {timestampLabel && <span>{timestampLabel}</span>}
              </div>
            )}
            {isUserTypeMessage && renderAttachments(msg.attachments)}
            {/* Show waiting indicator when streaming but no content yet */}
            {isWaiting || msg.isWaiting ? (
              <StreamingWaitIndicator isWaiting={true} />
            ) : (
              <>
                {/* Show recovered content if available, otherwise show normal content */}
                {msg.recoveredContent && msg.subtaskStatus === 'RUNNING'
                  ? renderRecoveredContent()
                  : renderMessageBody(msg, index)}
              </>
            )}
            {/* Show incomplete notice for completed but incomplete messages */}
            {msg.isIncomplete && msg.subtaskStatus !== 'RUNNING' && renderRecoveryNotice()}

            {/* Show error message and retry button for failed messages */}
            {!isUserTypeMessage && msg.status === 'error' && msg.error && (
              <div className="mt-4 space-y-3">
                {/* Error message */}
                <div className="flex items-start gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800">
                  <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm text-red-800 dark:text-red-200">
                      {onRetry
                        ? t('chat:errors.request_failed_retry')
                        : t('chat:errors.model_unsupported')}
                    </p>
                  </div>
                </div>

                {/* Retry button - positioned like BubbleTools for consistency */}
                {onRetry && (
                  <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onRetry(msg)}
                          className="h-8 w-8 hover:bg-muted"
                        >
                          <RefreshCw className="h-4 w-4 text-text-muted" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{t('actions.retry') || '重试'}</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            )}

            {/* Show copy button for user messages - visible on hover */}
            {isUserTypeMessage && (
              <div className="absolute -bottom-8 left-2 flex items-center gap-1 z-10 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                <CopyButton
                  content={msg.content}
                  className="h-[30px] w-[30px] !rounded-full bg-fill-tert hover:!bg-fill-sec"
                  tooltip={t('chat:actions.copy') || 'Copy'}
                  onCopySuccess={() => trace.copy(msg.type, msg.subtaskId)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function for memo
    // Only re-render if the message content or status changes
    // Note: Compare thinking array length to detect updates (for executor tasks)
    const prevThinkingLen = Array.isArray(prevProps.msg.thinking)
      ? prevProps.msg.thinking.length
      : 0;
    const nextThinkingLen = Array.isArray(nextProps.msg.thinking)
      ? nextProps.msg.thinking.length
      : 0;

    const prevSourcesLen =
      prevProps.msg.sources?.length || prevProps.msg.result?.sources?.length || 0;
    const nextSourcesLen =
      nextProps.msg.sources?.length || nextProps.msg.result?.sources?.length || 0;

    const shouldSkipRender =
      prevProps.msg.content === nextProps.msg.content &&
      prevProps.msg.subtaskStatus === nextProps.msg.subtaskStatus &&
      prevProps.msg.subtaskId === nextProps.msg.subtaskId &&
      prevProps.msg.timestamp === nextProps.msg.timestamp &&
      prevProps.msg.recoveredContent === nextProps.msg.recoveredContent &&
      prevProps.msg.isRecovered === nextProps.msg.isRecovered &&
      prevProps.msg.isIncomplete === nextProps.msg.isIncomplete &&
      prevProps.msg.isWaiting === nextProps.msg.isWaiting &&
      prevProps.isWaiting === nextProps.isWaiting &&
      prevProps.theme === nextProps.theme &&
      prevProps.onTextSelect === nextProps.onTextSelect &&
      prevProps.paragraphAction === nextProps.paragraphAction &&
      prevProps.isCurrentUserMessage === nextProps.isCurrentUserMessage &&
      prevProps.onRetry === nextProps.onRetry &&
      prevThinkingLen === nextThinkingLen &&
      prevSourcesLen === nextSourcesLen;

    return shouldSkipRender;
  }
);

export default MessageBubble;
