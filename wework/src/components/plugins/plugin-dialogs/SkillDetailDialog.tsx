import { BookOpenText, Boxes, Loader2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

export interface SkillDetailTarget {
  name: string
  pluginName: string
  pluginLogoUrl?: string | null
  description: string
  scenarios?: string
  invocation?: string
  installed: boolean
  enabled: boolean
  canToggle: boolean
}

interface SkillDetailDialogProps {
  skill: SkillDetailTarget
  running?: boolean
  onClose: () => void
  onRun: () => void
  onToggle?: (enabled: boolean) => void
}

export function SkillDetailDialog({
  skill,
  running = false,
  onClose,
  onRun,
  onToggle,
}: SkillDetailDialogProps) {
  const { t } = useTranslation('common')
  const closeRef = useRef<HTMLButtonElement>(null)
  const logo = skill.pluginLogoUrl?.trim() || ''

  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return (
    <div
      className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-6"
      onClick={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="skill-detail-dialog-title"
        data-testid="skill-detail-dialog"
        className="plugin-dialog-surface w-full max-w-[680px] overflow-hidden"
        onClick={event => event.stopPropagation()}
      >
        <div className="plugin-dialog-divider flex items-start gap-3 border-b px-6 py-5">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface text-text-secondary">
            <BookOpenText className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="skill-detail-dialog-title" className="heading-subsection truncate">
              {skill.name}
            </h2>
            <p className="text-xs text-text-muted">
              {t('workbench.plugin_component_type_skill', 'Skill')} ·{' '}
              {t('workbench.plugins_skill_source_plugin', '来源插件')} {skill.pluginName}
            </p>
          </div>
          {logo ? (
            <img src={logo} alt="" className="h-8 w-8 rounded-lg object-cover" />
          ) : (
            <Boxes className="h-8 w-8 text-text-muted" />
          )}
        </div>
        <div className="space-y-5 px-6 py-5 text-sm leading-5 text-text-secondary">
          <p>{skill.description}</p>
          {skill.scenarios && (
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.plugins_skill_scenarios', '适用场景')}
              </h3>
              <p className="mt-1">{skill.scenarios}</p>
            </div>
          )}
          {skill.invocation && (
            <div>
              <h3 className="text-sm font-medium text-text-primary">
                {t('workbench.plugins_skill_invocation', '调用方式')}
              </h3>
              <p className="mt-2 rounded-lg bg-surface px-3 py-2 font-mono text-xs text-text-primary">
                {skill.invocation}
              </p>
            </div>
          )}
        </div>
        <div className="plugin-dialog-divider flex items-center justify-between border-t px-6 py-4">
          {skill.canToggle && onToggle ? (
            <button
              type="button"
              data-testid="skill-detail-toggle"
              className="h-9 rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-surface"
              onClick={() => onToggle(!skill.enabled)}
            >
              {skill.enabled
                ? t('workbench.plugins_disable_skill', '禁用')
                : t('workbench.plugins_enable_skill', '恢复')}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              ref={closeRef}
              type="button"
              data-testid="skill-detail-close"
              className="h-9 rounded-lg px-4 text-sm font-medium text-text-secondary hover:bg-surface"
              onClick={onClose}
            >
              {t('workbench.close', '关闭')}
            </button>
            <button
              type="button"
              data-testid="skill-detail-run"
              disabled={!skill.installed || !skill.enabled || running}
              className="flex h-9 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
              onClick={onRun}
            >
              {running && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {t('workbench.plugins_run_skill', '运行技能')}
            </button>
          </div>
        </div>
      </section>
    </div>
  )
}
