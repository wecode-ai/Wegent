// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import { isJsonFile, isMarkdownFile } from './remote-workspace-utils'

type RemoteWorkspaceFormattedPreviewProps = {
  blob: Blob
  filename: string
}

function formatJsonContent(content: string): string {
  try {
    return JSON.stringify(JSON.parse(content), null, 2)
  } catch {
    return content
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

function parseJsonContent(content: string): JsonValue | null {
  try {
    return JSON.parse(content) as JsonValue
  } catch {
    return null
  }
}

function isJsonContainer(value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object'
}

function getJsonSummary(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `Array(${value.length})`
  }
  if (isJsonContainer(value)) {
    return `Object(${Object.keys(value).length})`
  }
  return JSON.stringify(value)
}

function getJsonNodeEntries(value: JsonValue): Array<[string, JsonValue]> {
  if (Array.isArray(value)) {
    return value.map((item, index) => [String(index), item])
  }
  if (isJsonContainer(value)) {
    return Object.entries(value)
  }
  return []
}

type JsonTreeNodeProps = {
  value: JsonValue
  label?: string
  path: string
  level: number
  collapsedPaths: Set<string>
  onToggle: (path: string) => void
}

function JsonTreeNode({ value, label, path, level, collapsedPaths, onToggle }: JsonTreeNodeProps) {
  const isContainer = isJsonContainer(value)
  const isCollapsed = collapsedPaths.has(path)
  const entries = getJsonNodeEntries(value)
  const nodeLabel = label ?? 'root'

  if (!isContainer) {
    return (
      <div
        className="flex min-h-6 items-center gap-2 font-mono text-sm"
        style={{ paddingLeft: level * 18 }}
      >
        {label && <span className="text-primary">{label}:</span>}
        <span className="text-text-primary">{JSON.stringify(value)}</span>
      </div>
    )
  }

  return (
    <div>
      <button
        type="button"
        className="flex min-h-6 items-center gap-1 rounded px-1 text-left font-mono text-sm text-text-primary hover:bg-surface"
        style={{ marginLeft: level * 18 }}
        aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${nodeLabel}`}
        onClick={() => onToggle(path)}
      >
        {isCollapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
        {label && <span className="text-primary">{label}:</span>}
        <span className="text-text-muted">{getJsonSummary(value)}</span>
      </button>
      {!isCollapsed &&
        entries.map(([entryKey, entryValue]) => (
          <JsonTreeNode
            key={`${path}.${entryKey}`}
            value={entryValue}
            label={entryKey}
            path={`${path}.${entryKey}`}
            level={level + 1}
            collapsedPaths={collapsedPaths}
            onToggle={onToggle}
          />
        ))}
    </div>
  )
}

function JsonTreePreview({ content }: { content: string }) {
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set())
  const parsedJson = useMemo(() => parseJsonContent(content), [content])

  const handleToggle = (path: string) => {
    setCollapsedPaths(previous => {
      const next = new Set(previous)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  if (parsedJson === null) {
    return (
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-text-primary">
        {formatJsonContent(content)}
      </pre>
    )
  }

  return (
    <div className="min-w-max space-y-0.5 py-2" data-testid="remote-workspace-json-tree">
      <JsonTreeNode
        value={parsedJson}
        path="$"
        level={0}
        collapsedPaths={collapsedPaths}
        onToggle={handleToggle}
      />
    </div>
  )
}

function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') {
    return blob.text()
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

export function RemoteWorkspaceFormattedPreview({
  blob,
  filename,
}: RemoteWorkspaceFormattedPreviewProps) {
  const [content, setContent] = useState('')

  useEffect(() => {
    let isMounted = true

    void readBlobText(blob).then(text => {
      if (isMounted) {
        setContent(text)
      }
    })

    return () => {
      isMounted = false
    }
  }, [blob])

  if (isMarkdownFile(filename)) {
    return (
      <div className="h-full overflow-auto bg-base p-6 text-sm text-text-primary">
        <div className="prose prose-sm max-w-none dark:prose-invert">
          <ReactMarkdown>{content}</ReactMarkdown>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto bg-base p-4">
      {isJsonFile(filename) ? (
        <JsonTreePreview content={content} />
      ) : (
        <pre className="m-0 whitespace-pre-wrap break-words font-mono text-sm leading-6 text-text-primary">
          {content}
        </pre>
      )}
    </div>
  )
}
