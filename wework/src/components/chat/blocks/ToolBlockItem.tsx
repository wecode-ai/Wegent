import { useState } from 'react'
import type { ProcessingBlock, ToolBlock } from '@/types/workbench'

interface ToolBlockItemProps {
  block: ProcessingBlock
}

export function ToolBlockItem({ block }: ToolBlockItemProps) {
  const [expanded, setExpanded] = useState(false)
  const isRunning = block.status !== 'done' && block.status !== 'error'

  if (block.type === 'thinking') {
    return <ThinkingBlockItem block={block} isRunning={isRunning} />
  }

  const { icon, label } = getBlockLabel(block)

  return (
    <div className="min-w-0 overflow-x-hidden text-sm">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex max-w-full items-center gap-1.5 text-text-secondary hover:text-text-primary"
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        {isRunning && <span className="animate-pulse text-xs">...</span>}
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? '' : '-rotate-90'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-2 min-w-0 overflow-x-hidden">
          {renderBlockDetail(block)}
        </div>
      )}
    </div>
  )
}

function ThinkingBlockItem({
  block,
  isRunning,
}: {
  block: Extract<ProcessingBlock, { type: 'thinking' }>
  isRunning: boolean
}) {
  if (!block.content) return null

  return (
    <div className="min-w-0 overflow-x-hidden text-sm">
      <div className="flex max-w-full items-start gap-1.5 text-text-secondary">
        <CommentaryIcon />
        <p className="min-w-0 whitespace-pre-wrap break-words leading-6">
          {block.content}
          {isRunning && <span className="animate-pulse text-xs">...</span>}
        </p>
      </div>
    </div>
  )
}

function getBlockLabel(block: ToolBlock): { icon: React.ReactNode; label: string } {
  const name = block.toolName.toLowerCase()
  const prefix = getToolStatusPrefix(block)

  if (name === 'bash' || name === 'execute_command' || name === 'run_terminal_command') {
    const command = getInputField(block, 'command', 'cmd')
    const shortCmd = command ? truncate(command.split('\n')[0], 40) : block.toolName
    return { icon: <TerminalIcon />, label: `${prefix.running} ${shortCmd}` }
  }
  if (name === 'write' || name === 'create_file' || name === 'write_file') {
    const filePath = getInputField(block, 'file_path', 'path')
    const fileName = filePath ? filePath.split('/').pop() : '文件'
    return { icon: <FileIcon />, label: `${prefix.create} ${fileName}` }
  }
  if (name === 'edit' || name === 'str_replace_editor' || name === 'edit_file') {
    const filePath = getInputField(block, 'file_path', 'path')
    const fileName = filePath ? filePath.split('/').pop() : '文件'
    return { icon: <EditIcon />, label: `${prefix.edit} ${fileName}` }
  }
  if (name === 'read' || name === 'read_file') {
    const filePath = getInputField(block, 'file_path', 'path')
    const fileName = filePath ? filePath.split('/').pop() : '文件'
    return { icon: <FileIcon />, label: `${prefix.read} ${fileName}` }
  }
  return { icon: <ToolIcon />, label: `${prefix.generic} ${block.toolName}` }
}

function getToolStatusPrefix(block: ToolBlock) {
  if (block.status === 'error') {
    return {
      running: '运行失败',
      create: '新增失败',
      edit: '编辑失败',
      read: '读取失败',
      generic: '执行失败',
    }
  }

  if (block.status === 'done') {
    return {
      running: '已运行',
      create: '已新增',
      edit: '已编辑',
      read: '已读取',
      generic: '已运行',
    }
  }

  return {
    running: '正在运行',
    create: '正在新增',
    edit: '正在编辑',
    read: '正在读取',
    generic: '正在运行',
  }
}

function TerminalIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3M4.5 19.5h15a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5h-15A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5z" />
    </svg>
  )
}

function FileIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
    </svg>
  )
}

function EditIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931z" />
    </svg>
  )
}

function ToolIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17l-5.1 5.1a2.121 2.121 0 11-3-3l5.1-5.1m0 0L15.17 4.83a2.121 2.121 0 113 3l-7.75 7.34z" />
    </svg>
  )
}

function CommentaryIcon() {
  return (
    <svg className="mt-1 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 8.25h9m-9 3h5.25M5.25 19.5l2.25-2.25h9A2.25 2.25 0 0018.75 15V6.75A2.25 2.25 0 0016.5 4.5h-9a2.25 2.25 0 00-2.25 2.25V19.5z" />
    </svg>
  )
}

function renderBlockDetail(block: ToolBlock) {
  const name = block.toolName.toLowerCase()

  if (name === 'bash' || name === 'execute_command' || name === 'run_terminal_command') {
    return <BashBlockDetail block={block} />
  }
  if (name === 'write' || name === 'create_file' || name === 'write_file') {
    return <FileWriteDetail block={block} />
  }
  if (name === 'edit' || name === 'str_replace_editor' || name === 'edit_file') {
    return <FileEditDetail block={block} />
  }

  const input = block.toolInput
  if (!input) return null
  return (
    <pre className="max-h-32 max-w-full overflow-auto rounded-lg bg-code-bg px-3 py-2 text-xs text-text-secondary">
      {JSON.stringify(input, null, 2)}
    </pre>
  )
}

function BashBlockDetail({ block }: { block: ToolBlock }) {
  const command = getInputField(block, 'command', 'cmd')
  const output = block.toolOutput
  const outputText = typeof output === 'string' ? output : output ? JSON.stringify(output, null, 2) : ''
  const isDone = block.status === 'done'
  const isError = block.status === 'error'
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    void navigator.clipboard.writeText(command ?? '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="min-w-0 overflow-x-hidden rounded-lg bg-code-bg px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs text-text-muted">Shell</span>
        <button type="button" onClick={handleCopy} className="p-0.5 text-text-muted hover:text-text-secondary">
          {copied ? (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
      {command && (
        <div className="overflow-x-auto font-mono text-xs leading-5 text-text-primary">
          <span className="text-text-muted">$ </span>{command}
        </div>
      )}
      {outputText && (
        <pre className="mt-1 max-h-48 max-w-full overflow-auto font-mono text-xs leading-5 text-text-secondary">
          {outputText.length > 2000 ? outputText.substring(0, 2000) + '...' : outputText}
        </pre>
      )}
      {(isDone || isError) && (
        <div className="mt-2 flex justify-end">
          {isDone && (
            <span className="flex items-center gap-1 text-xs text-text-muted">
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              成功
            </span>
          )}
          {isError && (
            <span className="text-xs text-red-500">失败</span>
          )}
        </div>
      )}
    </div>
  )
}

function FileWriteDetail({ block }: { block: ToolBlock }) {
  const filePath = getInputField(block, 'file_path', 'path')
  const content = getInputField(block, 'content', 'file_text')
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePath && <p className="break-words text-xs text-text-muted">{filePath}</p>}
      {content && (
        <pre className="max-h-40 max-w-full overflow-auto rounded-lg bg-code-bg px-3 py-2 text-xs leading-5 text-text-primary">
          {content.length > 500 ? content.substring(0, 500) + '...' : content}
        </pre>
      )}
    </div>
  )
}

function FileEditDetail({ block }: { block: ToolBlock }) {
  const filePath = getInputField(block, 'file_path', 'path')
  const oldStr = getInputField(block, 'old_string', 'old_str')
  const newStr = getInputField(block, 'new_string', 'new_str')
  return (
    <div className="min-w-0 space-y-1 overflow-x-hidden">
      {filePath && <p className="break-words text-xs text-text-muted">{filePath}</p>}
      {oldStr && (
        <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-red-50 px-3 py-2 text-xs leading-5 text-red-700">
          {oldStr.length > 300 ? oldStr.substring(0, 300) + '...' : oldStr}
        </pre>
      )}
      {newStr && (
        <pre className="max-h-24 max-w-full overflow-auto rounded-lg bg-green-50 px-3 py-2 text-xs leading-5 text-green-700">
          {newStr.length > 300 ? newStr.substring(0, 300) + '...' : newStr}
        </pre>
      )}
    </div>
  )
}

function getInputField(block: ToolBlock, ...keys: string[]): string | undefined {
  if (!block.toolInput) return undefined
  for (const key of keys) {
    const val = block.toolInput[key]
    if (typeof val === 'string') return val
  }
  return undefined
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str
  return str.substring(0, maxLen) + '...'
}
