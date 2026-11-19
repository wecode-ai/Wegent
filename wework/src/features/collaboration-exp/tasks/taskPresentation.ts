import { useTranslation } from '@/hooks/useTranslation'
import type { ExperienceTaskRow } from '../model'

export function useTaskDescription(row?: ExperienceTaskRow) {
  const { t } = useTranslation('collaborationExp')
  if (!row) return ''
  if (row.waitingFor.length)
    return t('tasks.waitingFor', { names: row.waitingFor.map(person => person.name).join('、') })
  if (row.assignee) return row.assignee.name ?? t('timeline.unknownMember')
  return row.statusName
}
