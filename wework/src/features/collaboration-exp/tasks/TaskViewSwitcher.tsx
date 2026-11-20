import { useTranslation } from '@/hooks/useTranslation'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import type { TaskListMode } from './TaskFilters'

export function TaskViewSwitcher({
  mode,
  onChange,
}: {
  mode: TaskListMode
  onChange?(mode: TaskListMode): void
}) {
  const { t } = useTranslation('collaborationExp')
  return (
    <SelectField<TaskListMode>
      value={mode}
      onChange={next => onChange?.(next)}
      disabled={!onChange}
      testId="collaboration-exp-task-view-mode"
      accessibleLabel={t('tasks.viewMode')}
      options={(['tasks', 'projects'] as const).map(option => ({
        value: option,
        label: t(option === 'tasks' ? 'tasks.title' : 'tasks.byProject'),
        testId: `collaboration-exp-task-view-mode-${option}`,
      }))}
    />
  )
}
