// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { memo, useState } from 'react';
import type { TaskDetail, Team, GitRepoInfo, GitBranch, Attachment } from '@/types/api';
import { Bot, Copy, Check, Download } from 'lucide-react';
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
    const bubbleBaseClasses =
      'relative group w-full p-5 pb-10 rounded-2xl border border-border text-text-primary shadow-sm';
    const bubbleTypeClasses = msg.type === 'user' ? 'bg-muted my-6' : 'bg-surface';
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
    const parseMarkdownClarification = (content: string): ClarificationData | null => {
      let actualContent = content;
      const codeBlockRegex = /^```(?:markdown)?\s*\n([\s\S]+?)\n```\s*$/;
      const codeBlockMatch = content.match(codeBlockRegex);

      if (codeBlockMatch) {
        actualContent = codeBlockMatch[1];
      }

      if (
        !actualContent.includes('## 🤔 需求澄清问题') &&
        !actualContent.includes('## 🤔 Clarification Questions')
      ) {
        return null;
      }

      const questions: ClarificationData['questions'] = [];
      const questionRegex = /### Q(\d+): (.*?)(?=\n\*\*Type\*\*:|$)/g;
      const matches = Array.from(actualContent.matchAll(questionRegex));

      for (const match of matches) {
        const questionNumber = parseInt(match[1]);
        const questionText = match[2].trim();

        const questionBlock = actualContent.substring(
          match.index!,
          actualContent.indexOf('\n### Q', match.index! + 1) !== -1
            ? actualContent.indexOf('\n### Q', match.index! + 1)
            : actualContent.length
        );

        const typeMatch = questionBlock.match(/\*\*Type\*\*:\s*(\w+)/);
        if (!typeMatch) continue;

        const questionType = typeMatch[1] as 'single_choice' | 'multiple_choice' | 'text_input';
        const questionId = `q${questionNumber}`;

        if (questionType === 'text_input') {
          questions.push({
            question_id: questionId,
            question_text: questionText,
            question_type: 'text_input',
          });
        } else {
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
      let actualContent = content;
      const codeBlockRegex = /^```(?:markdown)?\s*\n([\s\S]+?)\n```\s*$/;
      const codeBlockMatch = content.match(codeBlockRegex);

      if (codeBlockMatch) {
        actualContent = codeBlockMatch[1];
      }

      if (
        !actualContent.includes('## ✅ 最终需求提示词') &&
        !actualContent.includes('## ✅ Final Requirement Prompt')
      ) {
        return null;
      }

      const headingRegex = /## ✅ (?:最终需求提示词|Final Requirement Prompt)[^\n]*\n+([\s\S]+)/;
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
              </div>
            )}
            {isUserMessage && renderAttachments(msg.attachments)}
            {renderMessageBody(msg, index)}
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
      prevProps.theme === nextProps.theme
    );
  }
);

export default MessageBubble;
