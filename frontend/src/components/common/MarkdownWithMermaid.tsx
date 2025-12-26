// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { memo, useMemo } from 'react';
import MarkdownEditor from '@uiw/react-markdown-editor';
import dynamic from 'next/dynamic';

// Dynamically import MermaidDiagram to avoid SSR issues
const MermaidDiagram = dynamic(() => import('./MermaidDiagram'), {
  ssr: false,
  loading: () => (
    <div className="my-4 p-8 rounded-lg border border-border bg-surface flex items-center justify-center">
      <div className="flex items-center gap-3 text-text-secondary">
        <div className="animate-spin rounded-full h-5 w-5 border-2 border-primary border-t-transparent" />
        <span className="text-sm">Loading diagram...</span>
      </div>
    </div>
  ),
});

interface MarkdownWithMermaidProps {
  source: string;
  theme: 'light' | 'dark';
  /** Custom components to override default rendering */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components?: Record<string, React.ComponentType<any>>;
}

/**
 * Enhanced Markdown renderer with Mermaid diagram support
 *
 * Detects ```mermaid code blocks and renders them using MermaidDiagram component.
 * All other markdown is rendered using the standard MarkdownEditor.Markdown.
 */
export const MarkdownWithMermaid = memo(function MarkdownWithMermaid({
  source,
  theme,
  components,
}: MarkdownWithMermaidProps) {
  // Parse the source to extract mermaid blocks and regular content
  const contentParts = useMemo(() => {
    const parts: Array<{ type: 'markdown' | 'mermaid'; content: string }> = [];
    const mermaidRegex = /```mermaid\s*\n([\s\S]*?)```/g;

    let lastIndex = 0;
    let match;

    while ((match = mermaidRegex.exec(source)) !== null) {
      // Add markdown content before this mermaid block
      if (match.index > lastIndex) {
        const markdownContent = source.slice(lastIndex, match.index);
        if (markdownContent.trim()) {
          parts.push({ type: 'markdown', content: markdownContent });
        }
      }

      // Add the mermaid block
      const mermaidCode = match[1].trim();
      if (mermaidCode) {
        parts.push({ type: 'mermaid', content: mermaidCode });
      }

      lastIndex = match.index + match[0].length;
    }

    // Add remaining markdown content after the last mermaid block
    if (lastIndex < source.length) {
      const remainingContent = source.slice(lastIndex);
      if (remainingContent.trim()) {
        parts.push({ type: 'markdown', content: remainingContent });
      }
    }

    // If no mermaid blocks found, return the entire source as markdown
    if (parts.length === 0 && source.trim()) {
      parts.push({ type: 'markdown', content: source });
    }

    return parts;
  }, [source]);

  // Default components with link handling
  const defaultComponents = useMemo(
    () => ({
      a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props}>
          {children}
        </a>
      ),
      ...components,
    }),
    [components]
  );

  // If no mermaid blocks, render normally
  if (contentParts.length === 1 && contentParts[0].type === 'markdown') {
    return (
      <MarkdownEditor.Markdown
        source={source}
        style={{ background: 'transparent' }}
        wrapperElement={{ 'data-color-mode': theme }}
        components={defaultComponents}
      />
    );
  }

  // Render mixed content with mermaid diagrams
  return (
    <div className="markdown-with-mermaid">
      {contentParts.map((part, index) => {
        if (part.type === 'mermaid') {
          return <MermaidDiagram key={`mermaid-${index}`} code={part.content} />;
        }

        return (
          <MarkdownEditor.Markdown
            key={`markdown-${index}`}
            source={part.content}
            style={{ background: 'transparent' }}
            wrapperElement={{ 'data-color-mode': theme }}
            components={defaultComponents}
          />
        );
      })}
    </div>
  );
});

export default MarkdownWithMermaid;
