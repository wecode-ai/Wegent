import { useContext } from 'react'
import { AutomationRoleMembers } from './automationRoleMembers'
import { useTranslation } from '@/hooks/useTranslation'

export function AutomationRoleAssignee({
  value,
  onChange,
}: {
  value: number | null
  onChange: (value: number | null) => void
}) {
  const members = useContext(AutomationRoleMembers)
  const { t } = useTranslation()
  return (
    <label className="block text-sm">
      {t('todo.assignee')}
      <select
        data-testid="automation-role-assignee"
        value={value ?? ''}
        onChange={event => onChange(event.target.value ? Number(event.target.value) : null)}
        className="mt-1 block w-full rounded-lg border border-border bg-background p-2"
      >
        <option value="">{t('todo.assignee_unassigned_short')}</option>
        {members.map(member => (
          <option key={member.user_id} value={member.user_id}>
            {member.user_name || String(member.user_id)}
          </option>
        ))}
      </select>
    </label>
  )
}
