// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { TOOL_ICONS, DEFAULT_MAX_LINES, DEFAULT_MAX_LENGTH } from './constants';
import type { ThinkingStep, TodoItem } from '../types';

/**
 * Extract tool calls from thinking steps and count them
 */
export function extractToolCalls(thinkingSteps: ThinkingStep[]): Record<string, number> {
  const toolCounts: Record<string, number> = {};

  thinkingSteps.forEach(step => {
    if (step.details?.message?.content) {
      step.details.message.content.forEach(content => {
        if (content.type === 'tool_use' && content.name) {
          toolCounts[content.name] = (toolCounts[content.name] || 0) + 1;
        }
      });
    }
    // Also check direct tool_use type
    if (step.details?.type === 'tool_use' && step.details?.name) {
      toolCounts[step.details.name] = (toolCounts[step.details.name] || 0) + 1;
    }
  });

  return toolCounts;
}

/**
 * Calculate duration from thinking steps timestamps
 */
export function calculateDuration(thinkingSteps: ThinkingStep[]): string | null {
  if (thinkingSteps.length === 0) return null;

  let startTime: number | null = null;
  let endTime: number | null = null;

  // Get first timestamp
  for (const step of thinkingSteps) {
    if (step.details?.message?.id) {
      const timestamp = step.details?.timestamp || step.details?.created_at;
      if (timestamp) {
        startTime = new Date(timestamp).getTime();
        break;
      }
    }
  }

  // Get last timestamp
  for (let i = thinkingSteps.length - 1; i >= 0; i--) {
    const step = thinkingSteps[i];
    if (step.details?.message?.id) {
      const timestamp = step.details?.timestamp || step.details?.created_at;
      if (timestamp) {
        endTime = new Date(timestamp).getTime();
        break;
      }
    }
  }

  if (!startTime || !endTime) return null;

  const durationMs = endTime - startTime;
  const durationSec = durationMs / 1000;

  if (durationSec < 1) return '<1s';
  if (durationSec < 60) return `${durationSec.toFixed(1)}s`;

  const minutes = Math.floor(durationSec / 60);
  const seconds = Math.floor(durationSec % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format tool summary with icons
 */
export function formatToolSummary(toolCounts: Record<string, number>): string {
  const toolParts: string[] = [];

  Object.entries(toolCounts).forEach(([toolName, count]) => {
    if (count > 0 && TOOL_ICONS[toolName]) {
      toolParts.push(`${TOOL_ICONS[toolName]}×${count}`);
    }
  });

  return toolParts.join(' ');
}

/**
 * Check if content should be collapsible
 */
export function shouldCollapse(
  content: string,
  maxLines: number = DEFAULT_MAX_LINES,
  maxLength: number = DEFAULT_MAX_LENGTH
): boolean {
  if (!content || typeof content !== 'string') {
    return false;
  }

  const lines = content.split('\n');

  // Check if there are more than maxLines
  if (lines.length > maxLines) {
    return true;
  }

  // Check if any single line is too long (more than 100 characters)
  const hasLongLine = lines.some(line => line.length > 100);

  // Also check total character count as a fallback
  const isLongContent = content.length > maxLength;

  return hasLongLine || isLongContent;
}

/**
 * Get preview of content (first N lines or truncated long lines)
 */
export function getContentPreview(content: string, maxLines: number = DEFAULT_MAX_LINES): string {
  const lines = content.split('\n');
  const previewLines = [];

  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    const line = lines[i];
    // If line is very long, truncate it
    if (line.length > 100) {
      previewLines.push(line.substring(0, 100) + '...');
    } else {
      previewLines.push(line);
    }
  }

  return previewLines.join('\n');
}

/**
 * Format confidence value
 */
export function formatConfidence(confidence?: number): string | null {
  if (confidence === undefined || confidence === null || confidence === -1) return null;
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Check if task status is completed (terminal state)
 */
export function isTerminalStatus(status?: string): boolean {
  return status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED';
}

/**
 * Check if task status is running
 */
export function isRunningStatus(status?: string): boolean {
  return status === 'RUNNING' || status === 'PENDING' || status === 'PROCESSING';
}

/**
 * Parse TodoWrite input to extract todos
 */
export function parseTodoInput(input: unknown): TodoItem[] {
  if (!input || typeof input !== 'object') return [];

  const inputObj = input as { todos?: TodoItem[] };
  if (Array.isArray(inputObj.todos)) {
    return inputObj.todos;
  }

  return [];
}

/**
 * Parse tool_call tags from text content
 */
export interface ParsedToolCall {
  toolName: string;
  args: Record<string, string>;
  beforeText: string;
  afterText: string;
}

export function parseToolCallTags(text: string): ParsedToolCall | null {
  // Match <tool_call>...</tool_call> pattern
  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/;
  const match = text.match(toolCallRegex);

  if (!match) return null;

  const toolCallContent = match[1];
  const beforeText = text.substring(0, match.index).trim();
  const afterText = text.substring(match.index! + match[0].length).trim();

  // Extract tool name from the content before first <arg_key>
  const toolNameMatch = toolCallContent.match(/^\s*(\w+)\s*</);
  const toolName = toolNameMatch ? toolNameMatch[1] : 'Unknown';

  // Special handling for TodoWrite
  if (toolName === 'TodoWrite') {
    const todosMatch = toolCallContent.match(
      /<arg_key>todos<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/
    );
    if (todosMatch) {
      return {
        toolName,
        args: { todos: todosMatch[1] },
        beforeText,
        afterText,
      };
    }
  }

  // Extract all arguments
  const args: Record<string, string> = {};
  const argRegex = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
  let argMatch;

  while ((argMatch = argRegex.exec(toolCallContent)) !== null) {
    const key = argMatch[1].trim();
    const value = argMatch[2].trim();
    args[key] = value;
  }

  return {
    toolName,
    args,
    beforeText,
    afterText,
  };
}

/**
 * Get thinking translation text with template support
 */
export function getThinkingText(key: string, tChat: (key: string) => string): string {
  if (!key) return '';

  const templateRegex = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  let result = key;

  while ((match = templateRegex.exec(key)) !== null) {
    let templateKey = match[1];

    // Add chat: prefix for thinking keys if missing
    if (templateKey.startsWith('thinking.') && !templateKey.startsWith('chat:')) {
      templateKey = `chat:${templateKey}`;
    }

    if (templateKey.includes('.') || templateKey.includes(':')) {
      const translatedText = tChat(templateKey) || templateKey;
      result = result.replace(match[0], translatedText);
    } else {
      result = result.replace(match[0], templateKey);
    }
  }

  // Handle direct key that isn't a template
  if (result === key && (key.includes('.') || key.includes(':'))) {
    // Add chat: prefix for thinking keys if missing
    if (key.startsWith('thinking.') && !key.startsWith('chat:')) {
      const translated = tChat(`chat:${key}`);
      // return key if translation failed (returned key itself) AND original key didn't have chat prefix
      // Wait, t function returns key if missing?
      // If tChat('chat:key') returns 'chat:key', we might want to display just key or 'key'
      // But typically we return the translation.

      return translated !== `chat:${key}` ? translated : key;
    }
    return tChat(key) || key;
  }

  return result;
}
