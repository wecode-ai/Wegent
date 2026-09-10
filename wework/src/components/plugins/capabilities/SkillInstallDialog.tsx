import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import {
  previewSkills,
  installSkills,
  discardSkillPreview,
  type SkillPreview,
} from '@/api/local/capabilities'
import { useTranslation } from '@/hooks/useTranslation'
import { CapabilityDialog, fieldClass } from './CapabilityDialog'

const SOURCES_KEY = 'wework.skill-repositories'
function savedSources(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SOURCES_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}
export function SkillInstallDialog({
  kind,
  projectPath,
  onClose,
  onInstalled,
}: {
  kind: 'git' | 'local'
  projectPath: string
  onClose: () => void
  onInstalled: () => void
}) {
  const { t } = useTranslation('capabilities')
  const [source, setSource] = useState('')
  const [gitRef, setGitRef] = useState('')
  const [remember, setRemember] = useState(true)
  const [scope, setScope] = useState<'personal' | 'project'>('personal')
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const token = useRef<string | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(
    () => () => {
      if (token.current) void discardSkillPreview(token.current).catch(() => {})
    },
    []
  )
  async function choose(directory: boolean) {
    try {
      const result = await invokeDesktopHost<{ canceled: boolean; filePaths: string[] }>(
        'dialog.open',
        {
          properties: [directory ? 'openDirectory' : 'openFile'],
          ...(!directory ? { filters: [{ name: 'Skills ZIP', extensions: ['zip'] }] } : {}),
        }
      )
      if (!result.canceled && result.filePaths[0]) setSource(result.filePaths[0])
    } catch {
      setError(t('pickerFailed'))
    }
  }
  async function readSource() {
    setBusy(true)
    setError('')
    try {
      const result = await previewSkills(source.trim(), kind, gitRef.trim() || undefined)
      token.current = result.token
      setPreview(result)
      setSelected([])
      if (kind === 'git' && remember) {
        try {
          localStorage.setItem(
            SOURCES_KEY,
            JSON.stringify(
              [source.trim(), ...savedSources().filter(s => s !== source.trim())].slice(0, 10)
            )
          )
        } catch {
          /* Installation is independent of optional UI history. */
        }
      }
    } catch (e) {
      setError(`${t('previewFailed')} ${e instanceof Error ? e.message : ''}`)
    } finally {
      setBusy(false)
    }
  }
  async function install() {
    if (!preview) return
    setBusy(true)
    setError('')
    try {
      await installSkills(preview.token, selected, scope === 'project' ? projectPath : undefined)
      token.current = null
      onInstalled()
    } catch (e) {
      setError(`${t('installFailed')} ${e instanceof Error ? e.message : ''}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <CapabilityDialog
      title={t(kind === 'git' ? 'installGit' : 'importLocal')}
      id="skill-install-dialog"
      busy={busy}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={event => {
          event.preventDefault()
          void (preview ? install() : readSource())
        }}
      >
        <p className="text-sm text-text-secondary">{t(preview ? 'selectSkills' : 'readSource')}</p>
        {!preview ? (
          <>
            <label className="block space-y-2">
              {t(kind === 'git' ? 'repository' : 'localPath')}
              <input
                autoFocus
                required
                data-testid="skill-source"
                className={fieldClass}
                value={source}
                onChange={e => setSource(e.target.value)}
                list={kind === 'git' ? 'skill-repositories' : undefined}
                placeholder={
                  kind === 'git' ? 'git@git.intra.weibo.com:team/skills.git' : t('localPathHint')
                }
              />
            </label>
            {kind === 'git' ? (
              <>
                <datalist id="skill-repositories">
                  {savedSources().map(s => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <label className="block space-y-2">
                  {t('gitRef')}
                  <input
                    data-testid="skill-git-ref"
                    className={fieldClass}
                    value={gitRef}
                    onChange={e => setGitRef(e.target.value)}
                    placeholder={t('defaultBranch')}
                  />
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid="skill-remember-source"
                    checked={remember}
                    onChange={e => setRemember(e.target.checked)}
                  />
                  {t('rememberSource')}
                </label>
              </>
            ) : (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="skill-choose-folder"
                  onClick={() => void choose(true)}
                >
                  {t('chooseFolder')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="skill-choose-zip"
                  onClick={() => void choose(false)}
                >
                  {t('chooseZip')}
                </Button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 truncate text-sm text-text-secondary" title={source}>
                {source}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                data-testid="skill-change-source"
                onClick={async () => {
                  if (!token.current) return
                  setBusy(true)
                  try {
                    await discardSkillPreview(token.current)
                    token.current = null
                    setPreview(null)
                  } catch {
                    setError(t('previewFailed'))
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {t('change')}
              </Button>
            </div>
            <div className="max-h-64 overflow-y-auto divide-y divide-border rounded-lg border border-border">
              {preview.skills.map((skill, index) => (
                <label key={skill.path} className="flex cursor-pointer items-start gap-3 p-3">
                  <input
                    data-testid={`skill-candidate-${index}`}
                    type="checkbox"
                    disabled={busy}
                    checked={selected.includes(skill.path)}
                    onChange={e =>
                      setSelected(current =>
                        e.target.checked
                          ? [...current, skill.path]
                          : current.filter(p => p !== skill.path)
                      )
                    }
                    className="mt-1"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{skill.name}</span>
                    <span className="block text-sm text-text-secondary">{skill.description}</span>
                    <span className="block truncate text-xs text-text-muted">
                      {skill.path || 'SKILL.md'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            <label className="block space-y-2">
              {t('installTo')}
              <select
                data-testid="skill-install-scope"
                className={fieldClass}
                disabled={busy}
                value={scope}
                onChange={e => setScope(e.target.value as typeof scope)}
              >
                <option value="personal">{t('personal')}</option>
                <option value="project" disabled={!projectPath}>
                  {t('project')}
                </option>
              </select>
            </label>
            <p className="text-sm text-text-secondary">
              {scope === 'project' ? projectPath : t('personalHint')}
            </p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <footer className="flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="skill-install-cancel"
            disabled={busy}
            onClick={onClose}
          >
            {t('cancel')}
          </Button>
          <Button
            size="sm"
            data-testid="skill-install-submit"
            disabled={busy || (preview ? !selected.length : !source.trim())}
          >
            {busy && <Loader2 className="animate-spin" />}
            {preview ? t('installCount', { count: selected.length }) : t('readRepository')}
          </Button>
        </footer>
      </form>
    </CapabilityDialog>
  )
}
