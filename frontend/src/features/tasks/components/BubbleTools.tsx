// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState } from 'react';
import { Copy, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FeedbackState } from '@/hooks/useMessageFeedback';

// CopyButton component for copying markdown content
export const CopyButton = ({
  content,
  className,
  tooltip,
  onCopySuccess,
}: {
  content: string;
  className?: string;
  tooltip?: string;
  /** Optional callback when copy succeeds - used for telemetry */
  onCopySuccess?: () => void;
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(content);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
        onCopySuccess?.();
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
      onCopySuccess?.();
    } catch (err) {
      console.error('Fallback copy failed: ', err);
    }
  };

  const button = (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleCopy}
      className={className ?? 'h-8 w-8 hover:bg-muted'}
    >
      {copied ? (
        <Check className="h-4 w-4 text-green-500" />
      ) : (
        <Copy className="h-4 w-4 text-text-muted" />
      )}
    </Button>
  );

  if (tooltip) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent>{copied ? 'Copied!' : tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return button;
};

export interface BubbleToolsProps {
  contentToCopy: string;
  tools?: Array<{
    key: string;
    title: string;
    icon: React.ReactNode;
    onClick: () => void;
  }>;
  /** Optional callback when copy succeeds - used for telemetry */
  onCopySuccess?: () => void;
  /** Current feedback state (from useMessageFeedback hook) */
  feedback: FeedbackState;
  /** Handler for like button click (from useMessageFeedback hook) */
  onLike: () => void;
  /** Handler for dislike button click (from useMessageFeedback hook) */
  onDislike: () => void;
  /** Labels for feedback buttons */
  feedbackLabels?: {
    like: string;
    dislike: string;
  };
}

// Bubble toolbar: supports copy button, feedback buttons, and extensible tool buttons
const BubbleTools = ({
  contentToCopy,
  tools = [],
  onCopySuccess,
  feedback,
  onLike,
  onDislike,
  feedbackLabels,
}: BubbleToolsProps) => {
  return (
    <div className="absolute bottom-2 left-2 flex items-center gap-1 z-10">
      {/* Copy button */}
      <CopyButton content={contentToCopy} onCopySuccess={onCopySuccess} />
      {/* Feedback buttons: like and dislike */}
      <Button
        variant="ghost"
        size="icon"
        onClick={onLike}
        title={feedbackLabels?.like || 'Like'}
        className={`h-8 w-8 hover:bg-muted ${feedback === 'like' ? 'text-green-500' : ''}`}
      >
        <ThumbsUp
          className={`h-4 w-4 ${feedback === 'like' ? 'fill-current' : 'text-text-muted'}`}
        />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={onDislike}
        title={feedbackLabels?.dislike || 'Dislike'}
        className={`h-8 w-8 hover:bg-muted ${feedback === 'dislike' ? 'text-red-500' : ''}`}
      >
        <ThumbsDown
          className={`h-4 w-4 ${feedback === 'dislike' ? 'fill-current' : 'text-text-muted'}`}
        />
      </Button>
      {/* Additional tool buttons (e.g., download) */}
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

export default BubbleTools;
