import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, FolderOpen, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { openNativeDirectoryPicker } from '@/lib/native-directory-picker'
import {
  listStandaloneSkills,
  setSkillEnabled,
  removeSkill,
  isPluginSkill,
  canRemoveSkill,
  readCapabilityHome,
  type StandaloneSkill,
} from '@/api/local/capabilities'
import { SkillInstallDialog } from './SkillInstallDialog'
import { fieldClass } from './CapabilityDialog'

export function SkillsPanel({ onManagePlugin }: { onManagePlugin: () => void }) {
  const { t } = useTranslation('capabilities')
  const [skills, setSkills] = useState<StandaloneSkill[]>([])
  const [home, setHome] = useState('')
  const [projectPath, setProjectPath] = useState('')
  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [kind, setKind] = useState<'git' | 'local' | null>(null)
  const [removing, setRemoving] = useState<StandaloneSkill | null>(null)
  const requestId = useRef(0)
  const refresh = useCallback(() => {
    const id = ++requestId.current
    return Promise.all([listStandaloneSkills(projectPath || undefined), readCapabilityHome()])
      .then(([result, codexHome]) => {
        if (id !== requestId.current) return
        setSkills(result.skills)
        setHome(codexHome)
        setError(
          result.errors.length ? t('skillDiscoveryErrors', { count: result.errors.length }) : ''
        )
      })
      .catch(() => {
        if (id === requestId.current) setError(t('loadFailed'))
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false)
      })
  }, [projectPath, t])
  useEffect(() => {
    void refresh()
  }, [refresh])
  const visible = useMemo(
    () =>
      skills.filter(skill => {
        const repo = skill.scope === 'repo'
        return (
          (filter === 'all' ||
            (filter === 'project' ? repo : skill.scope === 'user' && !isPluginSkill(skill))) &&
          `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase())
        )
      }),
    [skills, query, filter]
  )
  async function toggle(skill: StandaloneSkill) {
    setPending(skill.path)
    setError('')
    try {
      await setSkillEnabled(skill.path, !skill.enabled)
      await refresh()
    } catch {
      setError(t('updateFailed'))
    } finally {
      setPending('')
    }
  }
  async function uninstall() {
    if (!removing) return
    setPending(removing.path)
    try {
      await removeSkill(removing.path, removing.scope === 'repo' ? projectPath : undefined)
      setRemoving(null)
      await refresh()
      setNotice(t('removed'))
    } catch {
      setError(t('removeFailed'))
      setRemoving(null)
    } finally {
      setPending('')
    }
  }
  return (
    <section
      data-testid="skills-panel"
      className="mx-auto flex h-full min-h-0 w-full max-w-[1120px] flex-col px-5 py-6 md:px-10"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="plugin-market-title">{t('installedSkills')}</h2>
          <p className="mt-1 text-sm text-text-secondary">{t('skillsDescription')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={loading}
            data-testid="skills-refresh"
            aria-label={t('refresh')}
            onClick={() => {
              setLoading(true)
              void refresh()
            }}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} />
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="skills-import"
            onClick={() => setKind('local')}
          >
            {t('importLocal')}
          </Button>
          <Button size="sm" data-testid="skills-install-git" onClick={() => setKind('git')}>
            {t('installGit')}
          </Button>
        </div>
      </header>
      <div className="my-5 flex flex-wrap items-center gap-3">
        <input
          data-testid="skills-search"
          className={`${fieldClass} max-w-sm`}
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder={t('searchSkills')}
          aria-label={t('searchSkills')}
        />
        <Button
          size="sm"
          variant="outline"
          data-testid="skills-project"
          onClick={async () => {
            try {
              const path = await openNativeDirectoryPicker(projectPath || undefined)
              if (path && path !== projectPath) {
                setLoading(true)
                setProjectPath(path)
                setNotice('')
              }
            } catch {
              setError(t('pickerFailed'))
            }
          }}
        >
          <FolderOpen />
          {t('selectProject')}
        </Button>
        {projectPath && (
          <span className="max-w-xs truncate text-sm text-text-secondary" title={projectPath}>
            {projectPath}
          </span>
        )}
      </div>
      <div className="mb-3 flex gap-1" role="group" aria-label={t('scope')}>
        {['all', 'personal', 'project'].map(value => (
          <Button
            key={value}
            size="sm"
            variant={filter === value ? 'secondary' : 'ghost'}
            aria-pressed={filter === value}
            data-testid={`skills-filter-${value}`}
            onClick={() => setFilter(value)}
          >
            {t(value)}
          </Button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mb-3 text-sm text-text-secondary">
          {notice}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-auto divide-y divide-border" aria-busy={loading}>
        {!loading && !visible.length && (
          <p className="py-12 text-center text-text-secondary">
            {t(query ? 'noSearchResults' : 'noSkills')}
          </p>
        )}
        {visible.map((skill, index) => (
          <div
            key={skill.path}
            data-testid={`skill-row-${index}`}
            className="flex items-start gap-3 py-4"
          >
            <FileText className="mt-1 size-5 shrink-0 text-text-secondary" />
            <div className="min-w-0 flex-1">
              <h3 className="font-medium">{skill.name}</h3>
              <p className="mt-1 text-sm text-text-secondary">{skill.description}</p>
              <p className="mt-1 text-xs text-text-muted">
                {t(
                  isPluginSkill(skill)
                    ? 'fromPlugin'
                    : skill.scope === 'repo'
                      ? 'project'
                      : skill.scope === 'user'
                        ? 'personal'
                        : 'system'
                )}
              </p>
              <details className="mt-1 text-xs text-text-muted">
                <summary data-testid={`skill-path-${index}`} className="cursor-pointer">
                  {t('viewPath')}
                </summary>
                <p className="break-all py-1">{skill.path}</p>
              </details>
            </div>
            {isPluginSkill(skill) ? (
              <Button
                size="sm"
                variant="outline"
                data-testid={`skill-manage-plugin-${index}`}
                onClick={onManagePlugin}
              >
                {t('managePlugin')}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <button
                  role="switch"
                  type="button"
                  aria-checked={skill.enabled}
                  aria-label={t('enableSkill', { name: skill.name })}
                  disabled={Boolean(pending)}
                  data-testid={`skill-toggle-${index}`}
                  className={`relative h-5 w-9 shrink-0 rounded-full focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50 ${skill.enabled ? 'bg-text-primary' : 'bg-muted'}`}
                  onClick={() => void toggle(skill)}
                >
                  <span
                    className={`absolute top-0.5 size-4 rounded-full bg-background transition-transform ${skill.enabled ? 'left-0.5 translate-x-4' : 'left-0.5'}`}
                  />
                </button>
                {canRemoveSkill(skill, home, projectPath) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid={`skill-remove-${index}`}
                    disabled={Boolean(pending)}
                    onClick={() => setRemoving(skill)}
                  >
                    {t('uninstall')}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="mt-4 text-xs text-text-muted">{t('personalHint')}</p>
      {kind && (
        <SkillInstallDialog
          kind={kind}
          projectPath={projectPath}
          onClose={() => setKind(null)}
          onInstalled={() => {
            setKind(null)
            setNotice(t('installed'))
            void refresh()
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title={t('uninstall')}
        description={t('removeSkillConfirm', { name: removing?.name })}
        cancelLabel={t('cancel')}
        confirmLabel={t('uninstall')}
        confirmTestId="skill-remove-confirm"
        destructive
        pending={Boolean(pending)}
        onClose={() => setRemoving(null)}
        onConfirm={() => void uninstall()}
      />
    </section>
  )
}
