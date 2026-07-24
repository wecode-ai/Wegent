import { useCallback } from 'react'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import TaskItem from '@tiptap/extension-task-item'
import TaskList from '@tiptap/extension-task-list'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Bold, Code, Italic, Link2, List, ListChecks, ListOrdered, Quote } from 'lucide-react'
import { Markdown, type MarkdownStorage } from 'tiptap-markdown'
import { cn } from '@/lib/utils'
import { normalizeTaskDescription } from './taskDescription'

interface TaskDescriptionEditorProps {
  value: string
  onChange: (markdown: string) => void
}

interface ToolbarButtonProps {
  label: string
  testId: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}

function ToolbarButton({ label, testId, active = false, onClick, children }: ToolbarButtonProps) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      onMouseDown={event => {
        event.preventDefault()
        onClick()
      }}
      onClick={event => {
        if (event.detail === 0) onClick()
      }}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md text-text-muted hover:bg-hover hover:text-text-primary',
        active && 'bg-selected text-text-primary'
      )}
    >
      {children}
    </button>
  )
}

export function TaskDescriptionEditor({ value, onChange }: TaskDescriptionEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    content: normalizeTaskDescription(value),
    extensions: [
      StarterKit,
      Link.configure({ openOnClick: false, autolink: true }),
      Placeholder.configure({ placeholder: '添加任务描述，输入 / 使用 Markdown…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: false,
        transformCopiedText: true,
        transformPastedText: true,
        breaks: true,
      }),
    ],
    editorProps: {
      attributes: {
        class:
          'tiptap prose prose-sm max-w-none min-h-48 text-text-primary outline-none prose-headings:text-text-primary prose-p:text-text-primary prose-strong:text-text-primary prose-code:text-text-primary prose-blockquote:text-text-secondary',
        'data-testid': 'cloud-todo-detail-description',
        'aria-label': '任务描述',
      },
    },
    onUpdate: ({ editor: currentEditor }) => {
      const markdown = currentEditor.storage.markdown as MarkdownStorage
      onChange(markdown.getMarkdown())
    },
  })

  const state = useEditorState({
    editor,
    selector: ({ editor: currentEditor }) => ({
      bold: currentEditor?.isActive('bold') ?? false,
      italic: currentEditor?.isActive('italic') ?? false,
      code: currentEditor?.isActive('code') ?? false,
      bulletList: currentEditor?.isActive('bulletList') ?? false,
      orderedList: currentEditor?.isActive('orderedList') ?? false,
      taskList: currentEditor?.isActive('taskList') ?? false,
      blockquote: currentEditor?.isActive('blockquote') ?? false,
      focused: currentEditor?.isFocused ?? false,
    }),
  })

  const setLink = useCallback(() => {
    if (!editor) return
    const currentHref = editor.getAttributes('link').href as string | undefined
    const href = window.prompt('输入链接地址', currentHref ?? 'https://')
    if (href === null) return
    if (!href.trim()) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run()
      return
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: href.trim() }).run()
  }, [editor])

  if (!editor) return <div className="min-h-48" />

  return (
    <div className="task-description-editor relative">
      <EditorContent editor={editor} />
      <div
        className={cn(
          'sticky bottom-3 mt-3 flex w-fit items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-md transition-opacity',
          state?.focused ? 'opacity-100' : 'pointer-events-none opacity-0'
        )}
        data-testid="cloud-todo-description-toolbar"
      >
        <ToolbarButton
          label="粗体"
          testId="cloud-todo-description-bold"
          active={state?.bold}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="斜体"
          testId="cloud-todo-description-italic"
          active={state?.italic}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="行内代码"
          testId="cloud-todo-description-code"
          active={state?.code}
          onClick={() => editor.chain().focus().toggleCode().run()}
        >
          <Code className="h-3.5 w-3.5" />
        </ToolbarButton>
        <span className="mx-1 h-4 w-px bg-border" />
        <ToolbarButton
          label="无序列表"
          testId="cloud-todo-description-bullet-list"
          active={state?.bulletList}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="有序列表"
          testId="cloud-todo-description-ordered-list"
          active={state?.orderedList}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="任务列表"
          testId="cloud-todo-description-task-list"
          active={state?.taskList}
          onClick={() => editor.chain().focus().toggleTaskList().run()}
        >
          <ListChecks className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="引用"
          testId="cloud-todo-description-blockquote"
          active={state?.blockquote}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label="链接" testId="cloud-todo-description-link" onClick={setLink}>
          <Link2 className="h-3.5 w-3.5" />
        </ToolbarButton>
      </div>
    </div>
  )
}
