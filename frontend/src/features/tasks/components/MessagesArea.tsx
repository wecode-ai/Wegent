// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTaskContext } from '../contexts/taskContext';
import type { TaskDetail, TaskDetailSubtask, Team, GitRepoInfo, GitBranch } from '@/types/api';
import { Bot, User, Copy, Check, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import MarkdownEditor from '@uiw/react-markdown-editor';
import { useTheme } from '@/features/theme/ThemeProvider';
import ThinkingComponent from './ThinkingComponent';
import ClarificationForm from './ClarificationForm';
import FinalPromptMessage from './FinalPromptMessage';
import ClarificationAnswerSummary from './ClarificationAnswerSummary';
import type { ClarificationData, FinalPromptData, ClarificationAnswer } from '@/types/api';

interface Message {
  type: 'user' | 'ai';
  content: string;
  timestamp: number;
  botName?: string;
  subtaskStatus?: string; // Add subtask-specific status
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
}

interface ResultWithThinking {
  thinking?: unknown[];
  value?: unknown;
}

// CopyButton component for copying markdown content
const CopyButton = ({ content, className }: { content: string; className?: string }) => {
  const [copied, setCopied] = useState(false);
  const { t } = useTranslation('chat');

  const handleCopy = async () => {
    // Prefer using Clipboard API
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        return;
      } catch (err) {
        console.error('Failed to copy text: ', err);
      }
    }

    // Fallback: use document.execCommand
    try {
      const textarea = document.createElement('textarea');
      textarea.value = content;
      textarea.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Fallback copy failed: ', err);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={className ?? 'h-8 w-8 hover:bg-muted'}
      title={t('messages.copy_markdown')}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 text-text-muted" />
      )}
    </Button>
  );
};

// Bubble toolbar: supports copy button and extensible tool buttons
const BubbleTools = ({
  contentToCopy,
  tools = [],
}: {
  contentToCopy: string;
  tools?: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    onClick: () => void;
  }>;
}) => {
  return (
    <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
      <CopyButton content={contentToCopy} />
      {tools.map(tool => (
        <Button
          key={tool.key}
          variant="ghost"
          size="icon"
          onClick={tool.onClick}
          title={tool.title}
          className="h-8 w-8 hover:bg-muted"
        >
          {tool.icon}
        </Button>
      ))}
    </div>
  );
};

interface MessagesAreaProps {
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
}

export default function MessagesArea({
  selectedTeam,
  selectedRepo,
  selectedBranch,
}: MessagesAreaProps) {
  const { t } = useTranslation('chat');
  const { selectedTaskDetail, refreshSelectedTaskDetail } = useTaskContext();
  const { theme } = useTheme();
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const scrollStateRef = useRef<{ scrollTop: number; scrollHeight: number }>({
    scrollTop: 0,
    scrollHeight: 0,
  });
  const isUserNearBottomRef = useRef(true);
  const AUTO_SCROLL_THRESHOLD = 32;

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    // Only auto-refresh when the task exists and is not completed
    if (
      selectedTaskDetail?.id &&
      selectedTaskDetail.status !== 'COMPLETED' &&
      selectedTaskDetail.status !== 'FAILED' &&
      selectedTaskDetail.status !== 'CANCELLED'
    ) {
      intervalId = setInterval(() => {
        refreshSelectedTaskDetail(true); // This is auto-refresh
      }, 5000);
    }

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, [selectedTaskDetail?.id, selectedTaskDetail?.status, refreshSelectedTaskDetail]);

  // Calculate messages from taskDetail
  function generateTaskMessages(detail: TaskDetail | null): Message[] {
    if (!detail) return [];
    const messages: Message[] = [];

    // When subtasks exist, synthesize according to useTaskActionData logic
    if (Array.isArray(detail.subtasks) && detail.subtasks.length > 0) {
      detail.subtasks.forEach((sub: TaskDetailSubtask) => {
        const promptContent = sub.prompt || '';
        let content;
        let msgType: 'user' | 'ai';
        let thinkingData: Message['thinking'] = null;

        if (sub.role === 'USER') {
          msgType = 'user';
          content = promptContent;
        } else {
          msgType = 'ai';
          let truncated = false;
          let shortPrompt = promptContent;
          const MAX_PROMPT_LENGTH = 50;
          if (promptContent.length > MAX_PROMPT_LENGTH) {
            shortPrompt = promptContent.substring(0, MAX_PROMPT_LENGTH) + '...';
            truncated = true;
          }

          // Generate aiContent
          let aiContent;
          const result = sub.result;

          // Debug: log the result structure
          console.log('Subtask result:', result);

          if (result) {
            if (typeof result === 'object') {
              const resultObj = result as ResultWithThinking;
              // Check for new data structure with thinking and value
              if (resultObj.thinking && Array.isArray(resultObj.thinking)) {
                thinkingData = resultObj.thinking as Message['thinking'];
              }
              // Also check if thinking might be in a nested structure
              else if (
                resultObj.value &&
                typeof resultObj.value === 'object' &&
                (resultObj.value as ResultWithThinking).thinking
              ) {
                thinkingData = (resultObj.value as ResultWithThinking)
                  .thinking as Message['thinking'];
              }
              // Check if thinking is in a string that needs to be parsed
              else if (typeof resultObj.value === 'string') {
                try {
                  const parsedValue = JSON.parse(resultObj.value) as ResultWithThinking;
                  if (parsedValue.thinking && Array.isArray(parsedValue.thinking)) {
                    thinkingData = parsedValue.thinking as Message['thinking'];
                  }
                } catch {
                  // Not valid JSON, ignore
                }
              }

              aiContent =
                result && 'value' in result
                  ? result.value !== null && result.value !== undefined && result.value !== ''
                    ? String(result.value)
                    : `__PROGRESS_BAR__:${sub.status}:${sub.progress}`
                  : result && 'thinking' in result
                    ? `__PROGRESS_BAR__:${sub.status}:${sub.progress}`
                    : JSON.stringify(result);
            } else {
              aiContent = String(result);
            }
          } else if (sub.status === 'COMPLETED') {
            aiContent = t('messages.subtask_completed');
          } else if (sub.status === 'FAILED') {
            aiContent = `${t('messages.subtask_failed')} ${sub.error_message || t('messages.unknown_error')}`;
          } else {
            aiContent = `__PROGRESS_BAR__:${sub.status}:${sub.progress}`;
          }

          // Merge prompt and aiContent, use special format when truncated
          if (truncated) {
            content = `__PROMPT_TRUNCATED__:${shortPrompt}::${promptContent}\${$$}$${aiContent}`;
          } else {
            content = `${promptContent}\${$$}$${aiContent}`;
          }
        }

        messages.push({
          type: msgType,
          content: content,
          timestamp: new Date(sub.updated_at).getTime(),
          botName:
            detail?.team?.workflow?.mode !== 'pipeline' && detail?.team?.name?.trim()
              ? detail.team.name
              : sub?.bots?.[0]?.name?.trim() || 'Bot',
          thinking: thinkingData,
          subtaskStatus: sub.status, // Add subtask status
        });
      });
    }

    return messages;
  }

  const displayMessages = generateTaskMessages(selectedTaskDetail);

  useEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const updateScrollMeta = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      scrollStateRef.current = {
        scrollTop,
        scrollHeight,
      };
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
    };

    const handleScroll = () => {
      updateScrollMeta();
    };

    container.addEventListener('scroll', handleScroll);

    // Initialize stored values
    updateScrollMeta();

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [selectedTaskDetail?.id, displayMessages.length, AUTO_SCROLL_THRESHOLD]);

  useLayoutEffect(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const previous = scrollStateRef.current;
    const shouldStickToBottom = isUserNearBottomRef.current;

    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      container.scrollTop = previous.scrollTop;
    }

    scrollStateRef.current = {
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
    };
    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    isUserNearBottomRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
  }, [displayMessages, AUTO_SCROLL_THRESHOLD]);

  const renderProgressBar = (status: string, progress: number) => {
    const normalizedStatus = (status ?? '').toUpperCase();
    const isActiveStatus = ['RUNNING', 'PENDING', 'PROCESSING'].includes(normalizedStatus);
    const safeProgress = Number.isFinite(progress) ? Math.min(Math.max(progress, 0), 100) : 0;

    return (
      <div className="mt-2">
        <div className="flex justify-between items-center mb-1">
          <span className="text-sm">
            {t('messages.task_status')} {status}
          </span>
        </div>
        <div className="w-full bg-border/60 rounded-full h-2">
          <div
            className={`bg-primary h-2 rounded-full transition-all duration-300 ease-in-out ${isActiveStatus ? 'progress-bar-animated' : ''}`}
            style={{ width: `${safeProgress}%` }}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={safeProgress}
            role="progressbar"
          ></div>
        </div>
      </div>
    );
  };

  const renderMarkdownResult = (rawResult: string, promptPart?: string) => {
    const trimmed = (rawResult ?? '').trim();
    const fencedMatch = trimmed.match(/^```(?:\s*(?:markdown|md))?\s*\n([\s\S]*?)\n```$/);
    const normalizedResult = fencedMatch ? fencedMatch[1] : trimmed;

    const progressMatch = normalizedResult.match(/^__PROGRESS_BAR__:(.*?):(\d+)$/);
    if (progressMatch) {
      const status = progressMatch[1];
      const progress = parseInt(progressMatch[2], 10) || 0;
      return renderProgressBar(status, progress);
    }

    return (
      <>
        <MarkdownEditor.Markdown
          source={normalizedResult}
          style={{ background: 'transparent' }}
          wrapperElement={{ 'data-color-mode': theme }}
          components={{
            a: ({ href, children, ...props }) => (
              <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
                {children}
              </a>
            ),
          }}
        />
        <BubbleTools
          contentToCopy={`${promptPart ? promptPart + '\n\n' : ''}${normalizedResult}`}
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
              },
            },
          ]}
        />
      </>
    );
  };

  const renderPlainMessage = (msg: Message) => {
    // Check if this is an external API params message
    if (msg.type === 'user' && msg.content.includes('[EXTERNAL_API_PARAMS]')) {
      const paramsMatch = msg.content.match(
        /\[EXTERNAL_API_PARAMS\]([\s\S]*?)\[\/EXTERNAL_API_PARAMS\]/
      );
      if (paramsMatch) {
        try {
          const params = JSON.parse(paramsMatch[1]);
          const remainingContent = msg.content
            .replace(/\[EXTERNAL_API_PARAMS\][\s\S]*?\[\/EXTERNAL_API_PARAMS\]\n?/, '')
            .trim();

          return (
            <div className="space-y-3">
              {/* Render parameters as cards */}
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
              {/* Render remaining content if any */}
              {remainingContent && <div className="text-sm break-all">{remainingContent}</div>}
            </div>
          );
        } catch (e) {
          console.error('Failed to parse EXTERNAL_API_PARAMS:', e);
          // Fall through to default rendering
        }
      }
    }

    // Check if this is a Markdown clarification answer (user message)
    if (msg.type === 'user' && msg.content.includes('## 📝 我的回答')) {
      // Parse Markdown answer format
      const answerPayload: ClarificationAnswer[] = [];

      // Extract all Q blocks (including Q1, Q2, etc. and ADDITIONAL_INPUT)
      const questionRegex = /### ([A-Z_\d]+): (.*?)\n\*\*Answer\*\*: ([\s\S]*?)(?=\n###|$)/g;
      let match;

      while ((match = questionRegex.exec(msg.content)) !== null) {
        const questionId = match[1].toLowerCase();
        const questionText = match[2].trim();
        const answerContent = match[3].trim();

        // Check if it's a multi-line answer (multiple choice with bullet points)
        if (answerContent.startsWith('-')) {
          // Multiple choice answer
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
          // Single choice answer: `value` - Label
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
          // Custom text answer
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
          />
        );
      }
    }

    return (msg.content?.split('\n') || []).map((line, idx) => {
      if (line.startsWith('__PROMPT_TRUNCATED__:')) {
        const match = line.match(/^__PROMPT_TRUNCATED__:(.*)::(.*)$/);
        if (match) {
          const shortPrompt = match[1];
          const fullPrompt = match[2];
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
        return renderProgressBar(status, progress);
      }

      return (
        <div key={idx} className="group pb-4">
          {idx === 0 && <BubbleTools contentToCopy={msg.content} tools={[]} />}
          <div className="text-sm break-all">{line}</div>
        </div>
      );
    });
  };

  // Helper function to parse Markdown clarification questions
  const parseMarkdownClarification = (content: string): ClarificationData | null => {
    // First, check if content is wrapped in a markdown code block
    // Support both ```markdown and ``` formats
    let actualContent = content;

    // Match markdown code block: ```markdown or ``` at start, followed by content, then ```
    const codeBlockRegex = /^```(?:markdown)?\s*\n([\s\S]+?)\n```\s*$/;
    const codeBlockMatch = content.match(codeBlockRegex);

    if (codeBlockMatch) {
      // Extract content from within the code block
      actualContent = codeBlockMatch[1];
    }

    // Check for clarification questions heading
    if (
      !actualContent.includes('## 🤔 需求澄清问题') &&
      !actualContent.includes('## 🤔 Clarification Questions')
    ) {
      return null;
    }

    const questions: ClarificationData['questions'] = [];

    // Match all questions: ### Q{number}: {question_text}
    const questionRegex = /### Q(\d+): (.*?)(?=\n\*\*Type\*\*:|$)/g;
    const matches = Array.from(actualContent.matchAll(questionRegex));

    for (const match of matches) {
      const questionNumber = parseInt(match[1]);
      const questionText = match[2].trim();

      // Find the type and options for this question
      const questionBlock = actualContent.substring(
        match.index!,
        actualContent.indexOf('\n### Q', match.index! + 1) !== -1
          ? actualContent.indexOf('\n### Q', match.index! + 1)
          : actualContent.length
      );

      // Extract type
      const typeMatch = questionBlock.match(/\*\*Type\*\*:\s*(\w+)/);
      if (!typeMatch) continue;

      const questionType = typeMatch[1] as 'single_choice' | 'multiple_choice' | 'text_input';
      const questionId = `q${questionNumber}`;

      if (questionType === 'text_input') {
        // Text input has no options
        questions.push({
          question_id: questionId,
          question_text: questionText,
          question_type: 'text_input',
        });
      } else {
        // Extract options for choice questions
        const options: ClarificationData['questions'][0]['options'] = [];
        const optionRegex = /- \[([ ✓])\] `([^`]+)` - (.*?)(?=\n-|\n\*\*|\n###|\n##|$)/g;
        let optionMatch;

        while ((optionMatch = optionRegex.exec(questionBlock)) !== null) {
          const isRecommended = optionMatch[1] === '✓';
          const value = optionMatch[2];
          const label = optionMatch[3]
            .trim()
            .replace(/\(recommended\)$/i, '')
            .trim();

          options.push({
            value,
            label,
            recommended: isRecommended,
          });
        }

        if (options.length > 0) {
          questions.push({
            question_id: questionId,
            question_text: questionText,
            question_type: questionType,
            options,
          });
        }
      }
    }

    if (questions.length === 0) return null;

    return {
      type: 'clarification',
      questions,
    };
  };

  // Helper function to parse Markdown final prompt
  const parseMarkdownFinalPrompt = (content: string): FinalPromptData | null => {
    // First, check if content is wrapped in a markdown code block
    // Support both ```markdown and ``` formats
    let actualContent = content;

    // Match markdown code block: ```markdown or ``` at start, followed by content, then ```
    const codeBlockRegex = /^```(?:markdown)?\s*\n([\s\S]+?)\n```\s*$/;
    const codeBlockMatch = content.match(codeBlockRegex);

    if (codeBlockMatch) {
      // Extract content from within the code block
      actualContent = codeBlockMatch[1];
    }

    // Check for final prompt heading
    if (
      !actualContent.includes('## ✅ 最终需求提示词') &&
      !actualContent.includes('## ✅ Final Requirement Prompt')
    ) {
      return null;
    }

    // Extract everything after the heading
    const headingRegex = /## ✅ (?:最终需求提示词|Final Requirement Prompt)[^\n]*\n+([\s\S]+)/;
    const match = actualContent.match(headingRegex);

    if (!match) return null;

    return {
      type: 'final_prompt',
      final_prompt: match[1].trim(),
    };
  };

  const renderAiMessage = (msg: Message, messageIndex: number) => {
    const content = msg.content ?? '';

    // Try to parse as clarification or final_prompt data
    try {
      let contentToParse = content;

      // Handle content with ${$$}$ separator
      if (content.includes('${$$}$')) {
        const [, result] = content.split('${$$}$');
        if (result) {
          contentToParse = result;
        }
      }

      // Try Markdown parsing first (new format)
      const markdownClarification = parseMarkdownClarification(contentToParse);
      if (markdownClarification) {
        return (
          <ClarificationForm
            data={markdownClarification}
            taskId={selectedTaskDetail?.id || 0}
            currentMessageIndex={messageIndex}
          />
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

    // Default rendering for normal messages
    if (!content.includes('${$$}$')) {
      return renderPlainMessage(msg);
    }

    const [prompt, result] = content.split('${$$}$');
    return (
      <>
        {prompt && <div className="text-sm whitespace-pre-line mb-2">{prompt}</div>}
        {result && renderMarkdownResult(result, prompt)}
      </>
    );
  };

  const renderMessageBody = (msg: Message, messageIndex: number) =>
    msg.type === 'ai' ? renderAiMessage(msg, messageIndex) : renderPlainMessage(msg);

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

  return (
    <div className="flex-1 w-full max-w-3xl mx-auto flex flex-col" data-chat-container="true">
      {/* Messages Area - only shown when there are messages or loading */}
      {displayMessages.length > 0 && (
        <div
          ref={messagesContainerRef}
          className="flex-1 overflow-y-auto mb-4 space-y-8 messages-container custom-scrollbar"
        >
          {displayMessages.map((msg, index) => {
            const bubbleBaseClasses =
              'relative group w-full p-5 pb-10 rounded-2xl border border-border text-text-primary shadow-sm';
            const bubbleTypeClasses = msg.type === 'user' ? 'bg-muted my-6' : 'bg-surface';
            const isUserMessage = msg.type === 'user';
            const timestampLabel = formatTimestamp(msg.timestamp);
            const headerIcon = isUserMessage ? (
              <User className="w-4 h-4" />
            ) : (
              <Bot className="w-4 h-4" />
            );
            const headerLabel = isUserMessage ? '' : msg.botName || t('messages.bot') || 'Bot';

            return (
              <div
                key={index}
                className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`flex ${isUserMessage ? 'max-w-[75%] w-auto' : 'w-full'} flex-col gap-3 ${isUserMessage ? 'items-end' : 'items-start'}`}
                >
                  {msg.type === 'ai' && msg.thinking && (
                    <ThinkingComponent thinking={msg.thinking} taskStatus={msg.subtaskStatus} />
                  )}
                  <div className={`${bubbleBaseClasses} ${bubbleTypeClasses}`}>
                    <div className="flex items-center gap-2 mb-2 text-xs opacity-80">
                      {headerIcon}
                      <span className="font-semibold">{headerLabel}</span>
                      {timestampLabel && <span>{timestampLabel}</span>}
                    </div>
                    {renderMessageBody(msg, index)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
