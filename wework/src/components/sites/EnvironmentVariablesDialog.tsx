import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { ApiError } from '@/api/http'
import type { EnvironmentSnapshot, Site, SitesApi } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { createRequestId } from '@/lib/request-id'
import {
  buildEnvironmentPatchOperations,
  createEmptyEnvironmentDraft,
  createEnvironmentDraft,
  type EnvironmentVariableDraft,
  validateEnvironmentDraft,
} from './environmentVariableDraft'

interface EnvironmentVariablesDialogProps {
  api: SitesApi
  site: Site
  onClose: () => void
}

function messageForValidation(code: string | null, t: ReturnType<typeof useTranslation>['t']) {
  if (code === 'invalid_key')
    return t('environment_invalid_key', '名称必须以大写字母开头，且只包含大写字母、数字和下划线')
  if (code === 'reserved_key') return t('environment_reserved_key', 'WEGENT_ 前缀由平台保留')
  if (code === 'duplicate_key') return t('environment_duplicate_key', '环境变量名称不能重复')
  if (code === 'secret_value_required')
    return t('environment_secret_required', '新建或替换 Secret 时必须输入值')
  return null
}

export function EnvironmentVariablesDialog({
  api,
  site,
  onClose,
}: EnvironmentVariablesDialogProps) {
  const { t } = useTranslation('sites')
  const [snapshot, setSnapshot] = useState<EnvironmentSnapshot | null>(null)
  const [rows, setRows] = useState<EnvironmentVariableDraft[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const nextId = useRef(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setSaved(false)
    try {
      const latest = await api.getEnvironmentVariables(site.siteid)
      setSnapshot(latest)
      setRows(createEnvironmentDraft(latest))
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t('environment_load_failed', '环境变量加载失败')
      )
    } finally {
      setLoading(false)
    }
  }, [api, site.siteid, t])

  useEffect(() => {
    let active = true
    void api
      .getEnvironmentVariables(site.siteid)
      .then(latest => {
        if (!active) return
        setSnapshot(latest)
        setRows(createEnvironmentDraft(latest))
      })
      .catch(loadError => {
        if (!active) return
        setError(
          loadError instanceof Error
            ? loadError.message
            : t('environment_load_failed', '环境变量加载失败')
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, site.siteid, t])

  const updateRow = (id: string, patch: Partial<EnvironmentVariableDraft>) => {
    setSaved(false)
    setRows(current => current.map(row => (row.id === id ? { ...row, ...patch } : row)))
  }

  const save = async () => {
    if (!snapshot || saving) return
    const validation = messageForValidation(validateEnvironmentDraft(rows), t)
    if (validation) {
      setError(validation)
      return
    }
    const operations = buildEnvironmentPatchOperations(snapshot, rows)
    if (operations.length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const revision = await api.patchEnvironmentVariables(
        site.siteid,
        { expected_revision_id: snapshot.revision_id, operations },
        createRequestId('site-environment')
      )
      const latest: EnvironmentSnapshot = {
        revision_id: revision.id,
        project_id: revision.project_id,
        revision_number: revision.revision_number,
        items: revision.variables,
      }
      setSnapshot(latest)
      setRows(createEnvironmentDraft(latest))
      setSaved(true)
    } catch (saveError) {
      const conflict =
        saveError instanceof ApiError && saveError.errorCode === 'ENVIRONMENT_REVISION_CONFLICT'
      setError(
        conflict
          ? t('environment_conflict', '配置已被其他操作更新，请重新加载后确认变更')
          : saveError instanceof Error
            ? saveError.message
            : t('environment_save_failed', '环境变量保存失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const validationCode = validateEnvironmentDraft(rows)
  const operations = snapshot ? buildEnvironmentPatchOperations(snapshot, rows) : []
  const canSave = !loading && !saving && !validationCode && operations.length > 0

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      onClick={event => {
        if (!saving && event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="environment-variables-dialog-title"
        data-testid="environment-variables-dialog"
        className="flex max-h-[82vh] w-full max-w-[760px] flex-col rounded-xl border border-border bg-popover shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <KeyRound className="h-4 w-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h2
              id="environment-variables-dialog-title"
              className="text-sm font-semibold text-text-primary"
            >
              {t('environment_title', '环境变量')}
            </h2>
            <p className="mt-1 text-xs text-text-secondary">
              {site.name} · {t('environment_next_deployment', '保存后将在下一次部署生效')}
            </p>
          </div>
          <button
            type="button"
            data-testid="environment-reload-button"
            disabled={loading || saving}
            onClick={() => void load()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {t('environment_reload', '重新加载')}
          </button>
        </header>

        <div className="min-h-40 flex-1 overflow-y-auto px-5 py-4">
          <p
            data-testid="environment-static-secret-warning"
            className="mb-3 flex items-start gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs text-text-secondary"
          >
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t(
              'environment_static_secret_warning',
              '静态站点会把变量注入浏览器；Secret 对所有站点访问者可见，只适用于内部受众。'
            )}
          </p>
          {loading ? (
            <div className="flex min-h-40 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
            </div>
          ) : (
            <div className="space-y-3">
              {rows.map(row => (
                <div
                  key={row.id}
                  className="grid gap-2 rounded-lg border border-border p-3 md:grid-cols-[1.25fr_110px_1.5fr_32px]"
                >
                  <input
                    aria-label={t('environment_key', '变量名')}
                    data-testid={`environment-key-${row.id}`}
                    value={row.key}
                    disabled={saving}
                    maxLength={128}
                    placeholder="API_BASE_URL"
                    onChange={event => updateRow(row.id, { key: event.target.value.toUpperCase() })}
                    className="h-9 rounded-md border border-border bg-background px-3 font-mono text-xs text-text-primary outline-none focus:border-focus"
                  />
                  <select
                    aria-label={t('environment_type', '类型')}
                    value={row.type}
                    disabled={saving}
                    onChange={event => {
                      const type = event.target.value === 'secret' ? 'secret' : 'plain'
                      updateRow(row.id, {
                        type,
                        value: '',
                        valueChanged: type !== row.type,
                        secretConfigured:
                          type === 'secret' && row.type === 'secret' && row.secretConfigured,
                      })
                    }}
                    className="h-9 rounded-md border border-border bg-background px-2 text-xs text-text-primary outline-none focus:border-focus"
                  >
                    <option value="plain">Plain</option>
                    <option value="secret">Secret</option>
                  </select>
                  <input
                    aria-label={t('environment_value', '值')}
                    data-testid={`environment-value-${row.id}`}
                    type={row.type === 'secret' ? 'password' : 'text'}
                    autoComplete="off"
                    value={row.value}
                    disabled={saving}
                    placeholder={
                      row.type === 'secret' && row.secretConfigured
                        ? t('environment_secret_configured', '已配置；留空保持不变')
                        : t('environment_value', '值')
                    }
                    onChange={event =>
                      updateRow(row.id, { value: event.target.value, valueChanged: true })
                    }
                    className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-xs text-text-primary outline-none focus:border-focus"
                  />
                  <button
                    type="button"
                    aria-label={t('environment_remove', '删除变量')}
                    disabled={saving}
                    onClick={() => setRows(current => current.filter(item => item.id !== row.id))}
                    className="flex h-9 w-8 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-danger disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                data-testid="environment-add-button"
                disabled={saving}
                onClick={() => {
                  nextId.current += 1
                  setRows(current => [
                    ...current,
                    createEmptyEnvironmentDraft(`new-${nextId.current}`),
                  ])
                  setSaved(false)
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-xs text-text-secondary hover:bg-muted"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('environment_add', '添加变量')}
              </button>
            </div>
          )}
          {(error || messageForValidation(validationCode, t)) && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-danger" role="alert">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error ?? messageForValidation(validationCode, t)}
            </p>
          )}
          {saved && (
            <p className="mt-3 text-xs text-text-secondary" role="status">
              {t('environment_saved', '已保存。新配置将在下一次部署时生效。')}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-between border-t border-border px-5 py-4">
          <span className="text-xs text-text-muted">
            {snapshot
              ? t('environment_revision', '已保存版本 {{number}}', {
                  number: snapshot.revision_number,
                })
              : ''}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="environment-close-button"
              onClick={onClose}
              disabled={saving}
              className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted disabled:opacity-50"
            >
              {t('close', '关闭')}
            </button>
            <button
              type="button"
              data-testid="environment-save-button"
              disabled={!canSave}
              onClick={() => void save()}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? t('saving', '保存中') : t('save', '保存')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}
