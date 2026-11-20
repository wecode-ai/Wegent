import type { Site, SiteAccessAudience, SitesApi } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { createRequestId } from '@/lib/request-id'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Radio, RadioGroup } from '@wegent/collaboration/controls/RadioGroup'
import { Textarea as ControlTextarea } from '@wegent/collaboration/controls/Textarea'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, Loader2, X } from 'lucide-react'
import { useRef, useState, useSyncExternalStore } from 'react'
import { useSiteDialogScope } from './useSiteDialogScope'

interface SiteAccessDialogProps {
  api: SitesApi
  site: Site
  onClose: () => void
}

const SUBJECT_PATTERN = /^[A-Za-z0-9._+-]+$/

function parseSubjects(value: string): string[] | null {
  const subjects = value
    .split(/[,\n]+/)
    .map(subject => subject.trim())
    .filter(Boolean)
  if (
    subjects.length === 0 ||
    subjects.length > 1000 ||
    subjects.some(subject => subject.length > 255 || !SUBJECT_PATTERN.test(subject)) ||
    new Set(subjects).size !== subjects.length
  ) {
    return null
  }
  return [...subjects].sort()
}

export function SiteAccessDialog(props: SiteAccessDialogProps) {
  const scope = useSiteDialogScope(props.api, props.site.siteid)
  return <SiteAccessDialogContent key={scope.key} {...props} restoreFocus={scope.restoreFocus} />
}

function SiteAccessDialogContent({
  api,
  site,
  onClose,
  restoreFocus,
}: SiteAccessDialogProps & { restoreFocus: () => HTMLElement | null }) {
  const { t } = useTranslation('sites')
  const [resource] = useState(() =>
    createAsyncResource(site.siteid, () => api.getSiteAccess(site.siteid))
  )
  const snapshot = useSyncExternalStore(resource.subscribe, resource.getSnapshot)
  const [draft, setDraft] = useState<{ audience: SiteAccessAudience; subjectsText: string } | null>(
    null
  )
  const audience = draft?.audience ?? snapshot.data?.audience ?? 'all'
  const subjectsText = draft?.subjectsText ?? snapshot.data?.subjects.join(', ') ?? ''
  const loading = snapshot.status === 'idle' || snapshot.status === 'loading'
  const loadFailed = snapshot.status === 'error'
  const [saving, setSaving] = useState(false)
  const [actionError, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const operation = useRef(false)
  const close = () => {
    if (!operation.current) onClose()
  }
  const error =
    actionError ??
    (loadFailed
      ? snapshot.error instanceof Error
        ? snapshot.error.message || t('access_load_failed', '访问权限加载失败')
        : t('access_load_failed', '访问权限加载失败')
      : null)
  const retryLoad = () => {
    setError(null)
    setSaved(false)
    void resource.reload()
  }

  const save = async () => {
    if (operation.current || loading || loadFailed) return
    const subjects = audience === 'custom' ? parseSubjects(subjectsText) : []
    if (audience === 'custom' && !subjects) {
      setSaved(false)
      setError(t('access_subjects_invalid', '请输入不重复的用户名，多个用户名使用逗号或换行分隔'))
      return
    }
    operation.current = true
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const policy = await api.updateSiteAccess(
        site.siteid,
        { audience, subjects: subjects ?? [] },
        createRequestId('site-access')
      )
      resource.update(() => policy)
      setDraft(null)
      setSaved(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('access_save_failed', '访问权限保存失败')
      )
    } finally {
      operation.current = false
      setSaving(false)
    }
  }

  const options: Array<{
    value: SiteAccessAudience
    label: string
    description: string
  }> = [
    {
      value: 'all',
      label: t('access_all', '所有人（免登录）'),
      description: t('access_all_description', '任何人都可以直接打开内网站点'),
    },
    {
      value: 'login',
      label: t('access_login', '登录用户'),
      description: t('access_login_description', '任何已登录的公司用户都可以访问'),
    },
    {
      value: 'owner',
      label: t('access_project_members', '仅项目成员'),
      description: t('access_project_members_description', '仅项目所有者和协作者可以访问'),
    },
    {
      value: 'custom',
      label: t('access_custom', '项目成员及指定成员'),
      description: t('access_custom_description', '项目成员和指定的公司用户可以访问'),
    },
  ]

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 px-4">
      <DialogSurface
        onClose={close}
        initialFocus={'[data-testid="site-access-close"]'}
        finalFocus={restoreFocus}
        render={
          <section
            aria-labelledby="site-access-title"
            data-testid="site-access-dialog"
            className="w-full max-w-lg rounded-[20px] border border-border bg-popover p-5 shadow-lg"
          />
        }
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="site-access-title" className="truncate text-base font-medium">
              {t('manage_access', '访问权限')}
            </h2>
            <p className="mt-1 truncate text-sm text-text-secondary">{site.name}</p>
          </div>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="site-access-close"
            aria-label={t('close', '关闭')}
            disabled={saving}
            onClick={close}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </ControlButton>
        </header>

        {loading ? (
          <div
            className="flex min-h-48 items-center justify-center text-text-secondary"
            role="status"
            aria-label={t('access_loading', '正在加载访问权限')}
          >
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
          </div>
        ) : loadFailed ? null : (
          <>
            <RadioGroup
              value={audience}
              name="site-access-audience"
              aria-label={t('access_scope', '访问范围')}
              onValueChange={next => {
                const option = options.find(option => option.value === next)
                if (option) {
                  setDraft({ audience: option.value, subjectsText })
                  setSaved(false)
                  setError(null)
                }
              }}
              render={<fieldset />}
              className="mt-5 space-y-2"
              disabled={saving}
            >
              <legend className="sr-only">{t('access_scope', '访问范围')}</legend>
              {options.map(option => (
                <label
                  key={option.value}
                  className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border/50 px-3 py-2.5 transition-colors hover:bg-surface"
                >
                  <Radio
                    value={option.value}
                    data-testid={`site-access-audience-${option.value}`}
                  />
                  <span className="min-w-0">
                    <strong className="block text-sm font-medium text-text-primary">
                      {option.label}
                    </strong>
                    <span className="mt-0.5 block text-xs leading-5 text-text-secondary">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>

            {audience === 'custom' ? (
              <label className="mt-4 block">
                <span className="text-sm font-medium text-text-primary">
                  {t('access_custom_subjects', '指定成员用户名')}
                </span>
                <ControlTextarea
                  value={subjectsText}
                  data-testid="site-access-subjects"
                  disabled={saving}
                  rows={3}
                  maxLength={8192}
                  placeholder={t('access_custom_subjects_placeholder', '例如 alice, bob')}
                  className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted keyboard:focus:border-focus/70 keyboard:focus:ring-2 keyboard:focus:ring-focus/15 disabled:opacity-60"
                  onChange={event => {
                    setDraft({ audience, subjectsText: event.target.value })
                    setSaved(false)
                    setError(null)
                  }}
                />
                <span className="mt-1 block text-xs leading-5 text-text-muted">
                  {t('access_custom_subjects_hint', '多个用户名使用逗号或换行分隔')}
                </span>
              </label>
            ) : null}

            <p className="mt-4 text-xs leading-5 text-text-muted">
              {t('access_members_always_allowed', '项目所有者和协作者始终可以访问该站点。')}
            </p>
          </>
        )}

        {error ? (
          <div className="mt-3 flex items-start gap-2 text-sm text-danger" role="alert">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{error}</span>
          </div>
        ) : null}
        {saved ? (
          <p className="mt-3 text-sm text-success" role="status">
            {t('access_saved', '访问权限已保存')}
          </p>
        ) : null}

        <footer className="mt-5 flex justify-end gap-2">
          {loadFailed ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="site-access-retry"
              onClick={retryLoad}
              className="h-10 rounded-lg px-4 text-sm text-text-primary hover:bg-surface"
            >
              {t('retry', '重试')}
            </ControlButton>
          ) : null}
          <ControlButton
            variant="ghost"
            size="sm"
            type="button"
            data-testid="site-access-cancel"
            disabled={saving}
            onClick={close}
            className="h-10 rounded-lg px-4 text-sm text-text-primary hover:bg-surface disabled:opacity-50"
          >
            {t('cancel', '取消')}
          </ControlButton>
          <ControlButton
            variant="primary"
            size="sm"
            type="button"
            data-testid="site-access-save"
            disabled={loading || saving || loadFailed}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {saving ? t('access_saving', '保存中…') : t('save', '保存')}
          </ControlButton>
        </footer>
      </DialogSurface>
    </div>
  )
}
