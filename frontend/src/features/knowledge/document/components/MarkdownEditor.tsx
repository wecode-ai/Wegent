// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import '@uiw/react-md-editor/markdown-editor.css';
import '@uiw/react-markdown-preview/markdown.css';

// Dynamically import the markdown editor to avoid SSR issues
const MDEditor = dynamic(() => import('@uiw/react-md-editor'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-[500px] bg-surface rounded-lg flex items-center justify-center">
      <span className="text-text-muted">Loading editor...</span>
    </div>
  ),
});

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  height?: number;
}

export function MarkdownEditor({
  value,
  onChange,
  readOnly = false,
  height = 500,
}: MarkdownEditorProps) {
  // Calculate the actual height considering the container
  const editorHeight = useMemo(() => {
    // Subtract some padding for better visual appearance
    return Math.max(height, 400);
  }, [height]);

  const handleChange = (val: string | undefined) => {
    onChange(val || '');
  };

  return (
    <div className="markdown-editor-wrapper" data-color-mode="light">
      <MDEditor
        value={value}
        onChange={handleChange}
        height={editorHeight}
        preview={readOnly ? 'preview' : 'live'}
        hideToolbar={readOnly}
        visibleDragbar={!readOnly}
        enableScroll={true}
        className="!bg-base !border-border"
        textareaProps={{
          placeholder: readOnly ? '' : 'Enter markdown content...',
          readOnly: readOnly,
        }}
      />
      <style jsx global>{`
        /* Custom styles for the markdown editor to match Wegent design system */
        .markdown-editor-wrapper .w-md-editor {
          --md-editor-background: rgb(var(--color-bg-base));
          --md-editor-border: rgb(var(--color-border));
          border-radius: 0.5rem;
          border: 1px solid rgb(var(--color-border));
          box-shadow: none;
        }

        .markdown-editor-wrapper .w-md-editor-toolbar {
          background: rgb(var(--color-bg-surface));
          border-bottom: 1px solid rgb(var(--color-border));
          border-radius: 0.5rem 0.5rem 0 0;
        }

        .markdown-editor-wrapper .w-md-editor-toolbar li button {
          color: rgb(var(--color-text-secondary));
        }

        .markdown-editor-wrapper .w-md-editor-toolbar li button:hover {
          color: rgb(var(--color-text-primary));
          background: rgb(var(--color-bg-surface));
        }

        .markdown-editor-wrapper .w-md-editor-toolbar li.active button {
          color: rgb(var(--color-primary));
        }

        .markdown-editor-wrapper .w-md-editor-content {
          background: rgb(var(--color-bg-base));
        }

        .markdown-editor-wrapper .w-md-editor-text-pre > code,
        .markdown-editor-wrapper .w-md-editor-text-input {
          font-size: 14px !important;
          line-height: 1.6 !important;
          color: rgb(var(--color-text-primary)) !important;
        }

        .markdown-editor-wrapper .w-md-editor-preview {
          background: rgb(var(--color-bg-base));
          padding: 16px;
        }

        .markdown-editor-wrapper .wmde-markdown {
          background: rgb(var(--color-bg-base)) !important;
          color: rgb(var(--color-text-primary)) !important;
          font-size: 14px;
          line-height: 1.6;
        }

        .markdown-editor-wrapper .wmde-markdown h1,
        .markdown-editor-wrapper .wmde-markdown h2,
        .markdown-editor-wrapper .wmde-markdown h3,
        .markdown-editor-wrapper .wmde-markdown h4,
        .markdown-editor-wrapper .wmde-markdown h5,
        .markdown-editor-wrapper .wmde-markdown h6 {
          color: rgb(var(--color-text-primary));
          border-bottom-color: rgb(var(--color-border));
        }

        .markdown-editor-wrapper .wmde-markdown code {
          background: rgb(var(--color-bg-surface));
          color: rgb(var(--color-primary));
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 13px;
        }

        .markdown-editor-wrapper .wmde-markdown pre {
          background: rgb(var(--color-bg-surface));
          border: 1px solid rgb(var(--color-border));
          border-radius: 8px;
          padding: 12px;
        }

        .markdown-editor-wrapper .wmde-markdown pre code {
          background: transparent;
          color: rgb(var(--color-text-primary));
          padding: 0;
        }

        .markdown-editor-wrapper .wmde-markdown blockquote {
          border-left: 4px solid rgb(var(--color-primary));
          color: rgb(var(--color-text-secondary));
          background: rgb(var(--color-bg-surface));
          padding: 8px 16px;
          margin: 16px 0;
          border-radius: 0 8px 8px 0;
        }

        .markdown-editor-wrapper .wmde-markdown a {
          color: rgb(var(--color-primary));
        }

        .markdown-editor-wrapper .wmde-markdown table {
          border-collapse: collapse;
          width: 100%;
        }

        .markdown-editor-wrapper .wmde-markdown table th,
        .markdown-editor-wrapper .wmde-markdown table td {
          border: 1px solid rgb(var(--color-border));
          padding: 8px 12px;
        }

        .markdown-editor-wrapper .wmde-markdown table th {
          background: rgb(var(--color-bg-surface));
        }

        .markdown-editor-wrapper .wmde-markdown hr {
          border-color: rgb(var(--color-border));
        }

        .markdown-editor-wrapper .wmde-markdown ul,
        .markdown-editor-wrapper .wmde-markdown ol {
          padding-left: 24px;
        }

        .markdown-editor-wrapper .wmde-markdown img {
          max-width: 100%;
          border-radius: 8px;
        }

        /* Divider styling */
        .markdown-editor-wrapper .w-md-editor-bar {
          background: rgb(var(--color-border));
        }

        /* Focus styles */
        .markdown-editor-wrapper .w-md-editor:focus-within {
          border-color: rgb(var(--color-primary));
        }
      `}</style>
    </div>
  );
}
