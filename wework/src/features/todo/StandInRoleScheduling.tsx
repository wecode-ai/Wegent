import { ArrowDown, ArrowUp } from 'lucide-react'
import type { CollaborationProject } from '@wegent/collaboration'
import { standInRoleName, type PersonalStandInSettings } from '@/api/personalStandIn'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInRoleScheduling({
  settings,
  projects,
  onChange,
  disabled,
}: {
  settings: PersonalStandInSettings
  projects: CollaborationProject[]
  onChange(settings: PersonalStandInSettings): void
  disabled: boolean
}) {
  const { t } = useTranslation('common')
  const move = (index: number, offset: number) => {
    const roles = [...settings.roles]
    const target = roles[index + offset]
    if (!target) return
    roles[index + offset] = roles[index]
    roles[index] = target
    onChange({ ...settings, roles })
  }
  return (
    <div className="space-y-6" data-testid="stand-in-scheduling">
      <label className="flex items-start gap-3">
        <input
          type="checkbox"
          data-testid="stand-in-auto-select"
          checked={settings.autoSelect}
          disabled={disabled}
          onChange={event => onChange({ ...settings, autoSelect: event.target.checked })}
          className="mt-1 accent-text-primary"
        />
        <span>
          <span className="font-medium">{t('standIn.personal.auto_select')}</span>
          <span className="mt-2 block text-sm text-text-muted">
            {t('standIn.personal.auto_select_help')}
          </span>
          <span className="mt-1 block text-sm text-text-muted">
            {t('standIn.personal.ordered_help')}
          </span>
        </span>
      </label>
      <div className="border-t border-border pt-4">
        <h3 className="font-medium">{t('standIn.personal.role_order')}</h3>
        <p className="mb-3 mt-1 text-xs text-text-muted">{t('standIn.personal.role_order_help')}</p>
        <div className="divide-y divide-border">
          {settings.roles.map((role, index) => (
            <div
              key={role.id}
              className="flex min-h-11 items-center gap-2 py-2"
              data-testid={`stand-in-order-row-${role.id}`}
            >
              <span className="min-w-0 flex-1 truncate">
                {standInRoleName(role, index, projects, t('standIn.personal.default_role'))}
              </span>
              {[-1, 1].map(offset => (
                <button
                  key={offset}
                  type="button"
                  disabled={
                    disabled || index + offset < 0 || index + offset >= settings.roles.length
                  }
                  data-testid={`stand-in-order-${offset < 0 ? 'up' : 'down'}-${role.id}`}
                  aria-label={`${t(offset < 0 ? 'standIn.personal.move_up' : 'standIn.personal.move_down')} ${standInRoleName(role, index, projects, t('standIn.personal.default_role'))}`}
                  onClick={() => move(index, offset)}
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-border text-text-secondary disabled:opacity-30"
                >
                  {offset < 0 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs text-text-muted">{t('standIn.personal.single_dispatch')}</p>
      </div>
    </div>
  )
}
