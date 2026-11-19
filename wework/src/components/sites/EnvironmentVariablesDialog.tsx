import { ApiError } from '@/api/http'
import type { EnvironmentSnapshot, Site, SitesApi } from '@/api/sites'
import { DialogForm } from '@/components/common/DialogForm'
import { useTranslation } from '@/hooks/useTranslation'
import { createRequestId } from '@/lib/request-id'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  type AsyncResourceSnapshot,
} from '@wegent/chat-core/async-resource'
import { DeleteIconButton } from '@wegent/collaboration/controls/DeleteIconButton'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, KeyRound, Loader2, Plus, RefreshCw } from 'lucide-react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type SetStateAction,
} from 'react'
import {
  buildEnvironmentPatchOperations,
  createEmptyEnvironmentDraft,
  createEnvironmentDraft,
  validateEnvironmentDraft,
  type EnvironmentVariableDraft,
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

type EnvironmentResource = ReturnType<typeof createAsyncResource<EnvironmentSnapshot>>
interface EnvironmentForm {
  resource: EnvironmentResource
  source: AsyncResourceSnapshot<EnvironmentSnapshot>
  snapshot: EnvironmentSnapshot | null
  rows: EnvironmentVariableDraft[]
  saving: boolean
  error: string | null
  saved: boolean
}
function createForm(
  resource: EnvironmentResource,
  source: AsyncResourceSnapshot<EnvironmentSnapshot>
): EnvironmentForm {
  return {
    resource,
    source,
    snapshot: null,
    rows: [],
    saving: false,
    error: null,
    saved: false,
  }
}

export function EnvironmentVariablesDialog({
  api,
  site,
  onClose,
}: EnvironmentVariablesDialogProps) {
  const { t } = useTranslation('sites')
  const siteid = site.siteid
  const resource = useMemo(
    () => createAsyncResource(siteid, () => api.getEnvironmentVariables(siteid)),
    [api, siteid]
  )
  const query = useSyncExternalStore(
    resource.subscribe,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const [form, setForm] = useState(() => createForm(resource, query))
  if (form.resource !== resource) setForm(createForm(resource, query))
  else if (query.status === 'ready' && form.source !== query) {
    const latest = query.data ?? null
    setForm({
      ...form,
      source: query,
      snapshot: latest,
      rows: latest ? createEnvironmentDraft(latest) : [],
      error: null,
      saved: false,
    })
  }
  const patchForm = useCallback(
    (
      change: Partial<EnvironmentForm> | ((current: EnvironmentForm) => Partial<EnvironmentForm>)
    ) => {
      setForm(current =>
        current.resource !== resource
          ? current
          : { ...current, ...(typeof change === 'function' ? change(current) : change) }
      )
    },
    [resource]
  )
  const setRows = (next: SetStateAction<EnvironmentVariableDraft[]>) =>
    patchForm(current => ({ rows: typeof next === 'function' ? next(current.rows) : next }))
  const setSaved = (saved: boolean) => patchForm({ saved })
  const setSaving = (saving: boolean) => patchForm({ saving })
  const setError = (error: string | null) => patchForm({ error })
  const { snapshot, rows, saving, saved } = form
  const loading = query.status === 'idle' || query.status === 'loading'
  const error =
    form.error ??
    (!saving && query.status === 'error'
      ? query.error instanceof Error
        ? query.error.message
        : t('environment_load_failed', '环境变量加载失败')
      : null)
  const nextId = useRef(0)
  const dialogRef = useRef<HTMLFormElement>(null)

  const load = () => {
    setError(null)
    setSaved(false)
    void resource.reload()
  }

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
      resource.update(() => latest)
      patchForm({
        source: resource.getSnapshot(),
        snapshot: latest,
        rows: createEnvironmentDraft(latest),
        saved: true,
      })
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
      <DialogSurface
        onClose={() => {
          if (!saving) onClose()
        }}
        render={
          <DialogForm
            onSubmit={event => {
              event.preventDefault()
              if (canSave) void save()
            }}
            ref={dialogRef}
            aria-labelledby="environment-variables-dialog-title"
            data-testid="environment-variables-dialog"
            className="flex max-h-[82vh] w-full max-w-[760px] flex-col rounded-xl border border-border bg-popover shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
          />
        }
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
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="environment-reload-button"
            disabled={loading || saving}
            onClick={() => void load()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-text-secondary hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            {t('environment_reload', '重新加载')}
          </ControlButton>
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
                  <ControlInput
                    aria-label={t('environment_key', '变量名')}
                    data-testid={`environment-key-${row.id}`}
                    value={row.key}
                    disabled={saving}
                    maxLength={128}
                    placeholder="API_BASE_URL"
                    onChange={event => updateRow(row.id, { key: event.target.value.toUpperCase() })}
                    className="h-9 font-mono text-xs"
                  />
                  <SelectRoot
                    value={normalizeSelectValue(row.type)}
                    disabled={saving}
                    onValueChange={selectedValue => {
                      if (selectedValue === null) return
                      const type = selectedValue === 'secret' ? 'secret' : 'plain'
                      updateRow(row.id, {
                        type,
                        value: '',
                        valueChanged: type !== row.type,
                        secretConfigured:
                          type === 'secret' && row.type === 'secret' && row.secretConfigured,
                      })
                    }}
                  >
                    <SelectTrigger
                      aria-label={t('environment_type', '类型')}
                      className="h-9 text-xs"
                    />
                    <SelectContent>
                      <SelectItem value="plain">Plain</SelectItem>
                      <SelectItem value="secret">Secret</SelectItem>
                    </SelectContent>
                  </SelectRoot>
                  <ControlInput
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
                    className="h-9 min-w-0 text-xs"
                  />
                  <DeleteIconButton
                    type="button"
                    aria-label={t('environment_remove', '删除变量')}
                    disabled={saving}
                    onClick={() => setRows(current => current.filter(item => item.id !== row.id))}
                    data-testid={`environment-variable-remove-${row.id}`}
                  />
                </div>
              ))}
              <ControlButton
                variant="outline"
                size="sm"
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
              </ControlButton>
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
            <ControlButton
              variant="ghost"
              size="sm"
              type="button"
              data-testid="environment-close-button"
              onClick={onClose}
              disabled={saving}
            >
              {t('close', '关闭')}
            </ControlButton>
            <ControlButton
              variant="primary"
              size="sm"
              type="submit"
              data-testid="environment-save-button"
              disabled={!canSave}
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {saving ? t('saving', '保存中') : t('save', '保存')}
            </ControlButton>
          </div>
        </footer>
      </DialogSurface>
    </div>
  )
}
