import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, X } from 'lucide-react'
import type { Site, SiteAccessAudience, SitesApi } from '@/api/sites'
import { useTranslation } from '@/hooks/useTranslation'
import { createRequestId } from '@/lib/request-id'

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

export function SiteAccessDialog({ api, site, onClose }: SiteAccessDialogProps) {
  const { t } = useTranslation('sites')
  const closeRef = useRef<HTMLButtonElement>(null)
  const [audience, setAudience] = useState<SiteAccessAudience>('all')
  const [subjectsText, setSubjectsText] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    try {
      const policy = await api.getSiteAccess(site.siteid)
      setAudience(policy.audience)
      setSubjectsText(policy.subjects.join(', '))
    } catch (reason) {
      setLoadFailed(true)
      setError(
        reason instanceof Error ? reason.message : t('access_load_failed', '访问权限加载失败')
      )
    } finally {
      setLoading(false)
    }
  }, [api, site.siteid, t])

  const retryLoad = () => {
    setLoading(true)
    setLoadFailed(false)
    setError(null)
    setSaved(false)
    void load()
  }

  useEffect(() => {
    let active = true
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    void api
      .getSiteAccess(site.siteid)
      .then(policy => {
        if (!active) return
        setAudience(policy.audience)
        setSubjectsText(policy.subjects.join(', '))
      })
      .catch(reason => {
        if (!active) return
        setLoadFailed(true)
        setError(
          reason instanceof Error ? reason.message : t('access_load_failed', '访问权限加载失败')
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      previouslyFocused?.focus()
    }
  }, [api, site.siteid, t])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose, saving])

  const save = async () => {
    if (saving || loading || loadFailed) return
    const subjects = audience === 'custom' ? parseSubjects(subjectsText) : []
    if (audience === 'custom' && !subjects) {
      setSaved(false)
      setError(t('access_subjects_invalid', '请输入不重复的用户名，多个用户名使用逗号或换行分隔'))
      return
    }
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const policy = await api.updateSiteAccess(
        site.siteid,
        { audience, subjects: subjects ?? [] },
        createRequestId('site-access')
      )
      setAudience(policy.audience)
      setSubjectsText(policy.subjects.join(', '))
      setSaved(true)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('access_save_failed', '访问权限保存失败')
      )
    } finally {
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
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-access-title"
        data-testid="site-access-dialog"
        className="w-full max-w-lg rounded-[20px] border border-border bg-popover p-5 shadow-lg"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="site-access-title" className="truncate text-base font-medium">
              {t('manage_access', '访问权限')}
            </h2>
            <p className="mt-1 truncate text-sm text-text-secondary">{site.name}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            data-testid="site-access-close"
            aria-label={t('close', '关闭')}
            disabled={saving}
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-text-secondary hover:bg-surface hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
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
            <fieldset className="mt-5 space-y-2" disabled={saving}>
              <legend className="sr-only">{t('access_scope', '访问范围')}</legend>
              {options.map(option => (
                <label
                  key={option.value}
                  className="flex min-h-14 cursor-pointer items-start gap-3 rounded-xl border border-border/50 px-3 py-2.5 transition-colors hover:bg-surface"
                >
                  <input
                    type="radio"
                    name="site-access-audience"
                    value={option.value}
                    checked={audience === option.value}
                    data-testid={`site-access-audience-${option.value}`}
                    className="mt-1 h-4 w-4 accent-neutral-900"
                    onChange={() => {
                      setAudience(option.value)
                      setSaved(false)
                      setError(null)
                    }}
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
            </fieldset>

            {audience === 'custom' ? (
              <label className="mt-4 block">
                <span className="text-sm font-medium text-text-primary">
                  {t('access_custom_subjects', '指定成员用户名')}
                </span>
                <textarea
                  value={subjectsText}
                  data-testid="site-access-subjects"
                  disabled={saving}
                  rows={3}
                  maxLength={8192}
                  placeholder={t('access_custom_subjects_placeholder', '例如 alice, bob')}
                  className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-focus/70 focus:ring-2 focus:ring-focus/15 disabled:opacity-60"
                  onChange={event => {
                    setSubjectsText(event.target.value)
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
            <button
              type="button"
              data-testid="site-access-retry"
              onClick={retryLoad}
              className="h-10 rounded-lg px-4 text-sm text-text-primary hover:bg-surface"
            >
              {t('retry', '重试')}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="site-access-cancel"
            disabled={saving}
            onClick={onClose}
            className="h-10 rounded-lg px-4 text-sm text-text-primary hover:bg-surface disabled:opacity-50"
          >
            {t('cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="site-access-save"
            disabled={loading || saving || loadFailed}
            onClick={() => void save()}
            className="flex h-10 items-center gap-2 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            {saving ? t('access_saving', '保存中…') : t('save', '保存')}
          </button>
        </footer>
      </section>
    </div>
  )
}
