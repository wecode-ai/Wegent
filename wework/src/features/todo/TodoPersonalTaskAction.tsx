import { LockKeyhole, Send } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export function TodoPersonalTaskAction({ onCreateTask }: { onCreateTask(): void }) {
  const { t } = useTranslation('common')
  return (
    <section className="task-detail-personal-task" data-testid="cloud-todo-personal-task-action">
      <span className="task-detail-personal-task-icon" aria-hidden="true">
        <LockKeyhole size={14} />
      </span>
      <span className="task-detail-personal-task-copy">
        <strong>{t('todo.personal_task_title')}</strong>
        <small>{t('todo.personal_task_description')}</small>
      </span>
      <button type="button" data-testid="cloud-todo-personal-task-start" onClick={onCreateTask}>
        <Send aria-hidden="true" size={14} />
        {t('todo.create_personal_task')}
      </button>
    </section>
  )
}
