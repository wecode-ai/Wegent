// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { memo, useState } from 'react';
import type { TaskDetail, Team, GitRepoInfo, GitBranch, Attachment } from '@/types/api';
import { Bot, Copy, Check, Download, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import MarkdownEditor from '@uiw/react-markdown-editor';
import ThinkingComponent from './ThinkingComponent';
import ClarificationForm from './ClarificationForm';
import FinalPromptMessage from './FinalPromptMessage';
import ClarificationAnswerSummary from './ClarificationAnswerSummary';
import AttachmentPreview from './AttachmentPreview';
import type { ClarificationData, FinalPromptData, ClarificationAnswer } from '@/types/api';

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
  attachments?: Attachment[];
  /** Recovered content from Redis/DB when user refreshes during streaming */
  recoveredContent?: string;
  /** Flag indicating this message has recovered content */
  isRecovered?: boolean;
  /** Flag indicating the content is incomplete (client disconnected) */
  isIncomplete?: boolean;
}

// CopyButton component for copying markdown content
const CopyButton = ({
  content,
  className,
  title,
}: {
  content: string;
  className?: string;
  title?: string;
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
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
      title={title || 'Copy'}
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

export interface MessageBubbleProps {
  msg: Message;
  index: number;
  selectedTaskDetail: TaskDetail | null;
  selectedTeam?: Team | null;
  selectedRepo?: GitRepoInfo | null;
  selectedBranch?: GitBranch | null;
  theme: 'light' | 'dark';
  t: (key: string) => string;
}

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
  }: MessageBubbleProps) {
    const bubbleBaseClasses = 'relative group w-full p-5 pb-10 text-text-primary';
    const bubbleTypeClasses =
      msg.type === 'user' ? 'my-6 rounded-2xl border border-border bg-muted shadow-sm' : '';
    const isUserMessage = msg.type === 'user';

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
    const headerIcon = isUserMessage ? null : <Bot className="w-4 h-4" />;
    const headerLabel = isUserMessage ? '' : msg.botName || t('messages.bot') || 'Bot';

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

        return (
          <div key={idx} className="group pb-4">
            {idx === 0 && <BubbleTools contentToCopy={message.content} tools={[]} />}
            <div className="text-sm break-all">{line}</div>
          </div>
        );
      });
    };

    // Helper function to parse Markdown clarification questions
    // Supports flexible formats: with/without code blocks, emoji variations, different header levels
    const parseMarkdownClarification = (content: string): ClarificationData | null => {
      let actualContent = content;

      // Try to extract content from code block (optional)
      const codeBlockRegex = /```(?:markdown)?\s*\n([\s\S]+?)\n```/;
      const codeBlockMatch = content.match(codeBlockRegex);
      if (codeBlockMatch) {
        actualContent = codeBlockMatch[1];
      }

      // Flexible header detection for clarification questions
      // Matches: ## 🤔 需求澄清问题, ## Clarification Questions, ### 澄清问题, # 需求澄清, etc.
      const clarificationHeaderRegex =
        /^#{1,6}\s*(?:🤔\s*)?(?:需求)?(?:澄清问题?|clarification\s*questions?)/im;
      if (!clarificationHeaderRegex.test(actualContent)) {
        return null;
      }

      const questions: ClarificationData['questions'] = [];

      // Flexible question header detection
      // Matches: ### Q1:, ### Q1：, **Q1:**, Q1:, Q1., 1., 1:, etc.
      const questionRegex =
        /(?:^|\n)(?:#{1,6}\s*)?(?:\*\*)?Q?(\d+)(?:\*\*)?[:.：]\s*(.*?)(?=\n(?:#{1,6}\s*)?(?:\*\*)?(?:Q?\d+|Type|类型)|\n\*\*(?:Type|类型)\*\*|$)/gi;
      const matches = Array.from(actualContent.matchAll(questionRegex));

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
          } else {
            const options: ClarificationData['questions'][0]['options'] = [];

            // Flexible option detection
            // Matches: - [✓] `value` - Label, - [x] value - Label, - [ ] `value` - Label, - `value` - Label
            const optionRegex =
              /- \[([✓xX* ]?)\]\s*`?([^`\n-]+)`?\s*-\s*(.*?)(?=\n-|\n\*\*|\n#{1,6}|$)/g;
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
              }
            }

            // Fallback: try simpler option format without checkbox
            // Matches: - `value` - Label, - value - Label
            if (options.length === 0) {
              const simpleOptionRegex = /-\s*`?([^`\n-]+)`?\s*-\s*(.*?)(?=\n-|\n\*\*|\n#{1,6}|$)/g;
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
            }
          }
        } catch {
          // Continue parsing other questions even if one fails
          continue;
        }
      }

      if (questions.length === 0) return null;

      return {
        type: 'clarification',
        questions,
      };
    };

    // Helper function to parse Markdown final prompt
    // Supports flexible formats: with/without code blocks, emoji variations, different header levels
    const parseMarkdownFinalPrompt = (content: string): FinalPromptData | null => {
      let actualContent = content;

      // Try to extract content from code block (optional)
      const codeBlockRegex = /```(?:markdown)?\s*\n([\s\S]+?)\n```/;
      const codeBlockMatch = content.match(codeBlockRegex);
      if (codeBlockMatch) {
        actualContent = codeBlockMatch[1];
      }

      // Flexible header detection for final prompt
      // Matches: ## ✅ 最终需求提示词, ## Final Requirement Prompt, ### 最终提示词, # final prompt, etc.
      const finalPromptHeaderRegex =
        /^#{1,6}\s*(?:✅\s*)?(?:最终(?:需求)?提示词|final\s*(?:requirement\s*)?prompt)/im;
      if (!finalPromptHeaderRegex.test(actualContent)) {
        return null;
      }

      // Extract content after the header
      // Matches various header formats and captures everything after
      const headingRegex =
        /#{1,6}\s*(?:✅\s*)?(?:最终(?:需求)?提示词|final\s*(?:requirement\s*)?prompt)[^\n]*\n+([\s\S]+)/i;
      const headingMatch = actualContent.match(headingRegex);

      if (!headingMatch) return null;

      return {
        type: 'final_prompt',
        final_prompt: headingMatch[1].trim(),
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

      if (!content.includes('${$$}$')) {
        return renderPlainMessage(message);
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
          {attachments.map(attachment => (
            <AttachmentPreview
              key={attachment.id}
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
    const renderRecoveredContent = () => {
      if (!msg.recoveredContent || msg.subtaskStatus !== 'RUNNING') return null;

      return (
        <div className="space-y-2">
          {msg.recoveredContent ? (
            <>
              <MarkdownEditor.Markdown
                source={msg.recoveredContent}
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
              {/* Blinking cursor to indicate streaming is in progress */}
              <div className="absolute bottom-2 left-2 z-10 h-8 flex items-center px-2">
                <span className="animate-pulse text-primary">▊</span>
              </div>
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

    return (
      <div className={`flex ${isUserMessage ? 'justify-end' : 'justify-start'}`}>
        <div
          className={`flex ${isUserMessage ? 'max-w-[75%] w-auto' : 'w-full'} flex-col gap-3 ${isUserMessage ? 'items-end' : 'items-start'}`}
        >
          {msg.type === 'ai' && msg.thinking && (
            <ThinkingComponent thinking={msg.thinking} taskStatus={msg.subtaskStatus} />
          )}
          <div className={`${bubbleBaseClasses} ${bubbleTypeClasses}`}>
            {!isUserMessage && (
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
            {isUserMessage && renderAttachments(msg.attachments)}
            {/* Show recovered content if available, otherwise show normal content */}
            {msg.recoveredContent && msg.subtaskStatus === 'RUNNING'
              ? renderRecoveredContent()
              : renderMessageBody(msg, index)}
            {/* Show incomplete notice for completed but incomplete messages */}
            {msg.isIncomplete && msg.subtaskStatus !== 'RUNNING' && renderRecoveryNotice()}
          </div>
        </div>
      </div>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function for memo
    // Only re-render if the message content or status changes
    return (
      prevProps.msg.content === nextProps.msg.content &&
      prevProps.msg.subtaskStatus === nextProps.msg.subtaskStatus &&
      prevProps.msg.subtaskId === nextProps.msg.subtaskId &&
      prevProps.msg.timestamp === nextProps.msg.timestamp &&
      prevProps.msg.recoveredContent === nextProps.msg.recoveredContent &&
      prevProps.msg.isRecovered === nextProps.msg.isRecovered &&
      prevProps.msg.isIncomplete === nextProps.msg.isIncomplete &&
      prevProps.theme === nextProps.theme
    );
  }
);

export default MessageBubble;
