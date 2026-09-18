import { useEffect, useRef, useState, type FormHTMLAttributes, type ReactNode } from 'react'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import styles from './ProjectChatComposer.module.css'

export const PROJECT_CHAT_EDITOR_CLASS = cn(
  'max-h-[112px] min-h-12 w-full resize-none overflow-y-auto bg-transparent px-0 pb-0 pt-1 text-chat text-text-primary outline-none placeholder:text-text-muted/55',
  styles.input
)
export const PROJECT_CHAT_TOOLBAR_CLASS = styles.toolbar

/** One PC composer surface; host adapters own draft and runtime effects. */
export function ProjectChatComposerSurface({
  workBar,
  children,
  formProps,
  canCollapseInShortPane = false,
  collapseWhenIdle = false,
  isDraggingFiles = false,
}: {
  workBar?: ReactNode
  children: ReactNode
  formProps: Omit<FormHTMLAttributes<HTMLFormElement>, 'className' | 'children'>
  canCollapseInShortPane?: boolean
  collapseWhenIdle?: boolean
  isDraggingFiles?: boolean
}) {
  const formRef = useRef<HTMLFormElement>(null)
  const [shortComposerExpanded, setShortComposerExpanded] = useState(false)
  useEffect(() => {
    if (!shortComposerExpanded) return
    const outside = (event: MouseEvent) => {
      if (!formRef.current?.contains(event.target as Node)) setShortComposerExpanded(false)
    }
    window.addEventListener('click', outside, true)
    return () => window.removeEventListener('click', outside, true)
  }, [shortComposerExpanded])
  return (
    <div
      data-testid="project-chat-composer"
      className="relative w-full rounded-[26px] bg-surface shadow-[0_0_0_0.5px_rgba(13,13,13,0.12),0_3px_7.5px_rgba(0,0,0,0.04),0_0_20px_rgba(0,0,0,0.05)]"
    >
      {workBar}
      <form
        {...formProps}
        onClickCapture={event => {
          setShortComposerExpanded(true)
          formProps.onClickCapture?.(event)
        }}
        onFocusCapture={event => {
          setShortComposerExpanded(true)
          formProps.onFocusCapture?.(event)
        }}
        ref={formRef}
        data-testid="project-chat-composer-form"
        data-short-collapse={canCollapseInShortPane ? 'true' : undefined}
        data-short-expanded={shortComposerExpanded ? 'true' : 'false'}
        className={cn(
          'relative z-10 flex min-h-[76px] w-full flex-col rounded-[26px] border bg-background px-4 pb-1.5 pt-2 transition-colors',
          styles.form,
          collapseWhenIdle && styles.collapseWhenIdle,
          isDraggingFiles ? 'border-focus ring-2 ring-focus/20' : 'border-border/45'
        )}
      >
        {children}
      </form>
    </div>
  )
}
