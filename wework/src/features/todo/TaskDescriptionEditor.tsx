import { lazy, Suspense } from 'react'
import type { TaskDescriptionEditorProps } from './TaskDescriptionEditorContent'

const Editor = lazy(() =>
  import('./TaskDescriptionEditorContent').then(module => ({
    default: module.TaskDescriptionEditor,
  }))
)

export function TaskDescriptionEditor(props: TaskDescriptionEditorProps) {
  return (
    <Suspense
      fallback={
        <div
          aria-busy="true"
          className={props.className}
          data-testid={`${props.testId ?? 'cloud-todo-detail-description'}-loading`}
        />
      }
    >
      <Editor {...props} />
    </Suspense>
  )
}
