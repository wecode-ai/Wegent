import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Loader2, X } from 'lucide-react'
import { ApiError } from '@/api/http'
import type { Site, SiteAnalytics, SiteAnalyticsRange, SitesApi } from '@/api/sites'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { analyticsToday, recentAnalyticsRange, validAnalyticsRange } from './siteAnalyticsDates'

interface SiteAnalyticsDialogProps {
  api: SitesApi
  site: Site
  onClose: () => void
}

const controlClass =
  'h-11 rounded-lg border border-border px-3 text-sm text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50 md:h-8'

function errorKey(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = error.detail as { code?: string } | undefined
    if (detail?.code === 'ANALYTICS_NOT_CONFIGURED') return 'analytics_not_configured'
    if (detail?.code === 'ANALYTICS_RATE_LIMITED') return 'analytics_rate_limited'
    if (detail?.code === 'ANALYTICS_TIMEOUT') return 'analytics_timeout'
  }
  return 'analytics_load_failed'
}

export function SiteAnalyticsDialog({ api, site, onClose }: SiteAnalyticsDialogProps) {
  const { t } = useTranslation('sites')
  const [draft, setDraft] = useState<SiteAnalyticsRange>(() => recentAnalyticsRange(7))
  const [request, setRequest] = useState(() => ({ range: draft, revision: 0 }))
  const [settled, setSettled] = useState<{
    request: typeof request
    api: SitesApi
    siteid: string
    data: SiteAnalytics | null
    error: string | null
  } | null>(null)
  const current =
    settled?.request === request && settled.api === api && settled.siteid === site.siteid
      ? settled
      : null
  const loading = current === null
  const data = current?.data ?? null
  const error = current?.error ?? null
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onClose)
  const today = analyticsToday()
  const valid = validAnalyticsRange(draft, today)
  const changed =
    draft.start_date !== request.range.start_date || draft.end_date !== request.range.end_date

  useEffect(() => {
    let active = true
    void api
      .getSiteAnalytics(site.siteid, request.range)
      .then(result => {
        if (active) setSettled({ request, api, siteid: site.siteid, data: result, error: null })
      })
      .catch(failure => {
        if (active)
          setSettled({ request, api, siteid: site.siteid, data: null, error: errorKey(failure) })
      })
    return () => {
      active = false
    }
  }, [api, site.siteid, request])

  function query(range = draft) {
    if (!validAnalyticsRange(range)) return
    setDraft(range)
    setRequest(previous => ({ range, revision: previous.revision + 1 }))
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/[0.13]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="site-analytics-title"
        data-testid="site-analytics-dialog"
        tabIndex={-1}
        className="flex max-h-[90vh] w-[680px] max-w-[92vw] flex-col rounded-[20px] bg-popover text-text-primary shadow-lg ring-[0.5px] ring-border"
      >
        <header className="flex items-start justify-between gap-4 p-5 pb-4">
          <div className="min-w-0">
            <h2 id="site-analytics-title" className="text-heading-sm font-medium">
              {t('view_analytics')}
            </h2>
            <p className="mt-1 truncate text-sm text-text-secondary">{site.name}</p>
          </div>
          <button
            type="button"
            data-testid="site-analytics-close"
            aria-label={t('analytics_close')}
            onClick={onClose}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 md:h-8 md:w-8"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>
        <div className="overflow-y-auto px-5 pb-5">
          <form
            onSubmit={event => {
              event.preventDefault()
              query()
            }}
            noValidate
          >
            <div className="flex flex-wrap items-end gap-2">
              {(['start_date', 'end_date'] as const).map(field => (
                <label
                  key={field}
                  className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-text-secondary"
                >
                  {t(field === 'start_date' ? 'analytics_start_date' : 'analytics_end_date')}
                  <input
                    type="date"
                    value={draft[field]}
                    max={today}
                    required
                    data-testid={`site-analytics-${field}`}
                    aria-invalid={!valid}
                    aria-describedby="site-analytics-range-hint"
                    onChange={event =>
                      setDraft(previous => ({ ...previous, [field]: event.target.value }))
                    }
                    className={`${controlClass} w-full bg-background`}
                  />
                </label>
              ))}
              <button
                type="submit"
                data-testid="site-analytics-query"
                disabled={!valid || (loading && !changed)}
                className="h-11 rounded-lg bg-text-primary px-4 text-sm text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-50 md:h-8"
              >
                {t('analytics_query')}
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {[7, 31].map(days => (
                <button
                  key={days}
                  type="button"
                  data-testid={`site-analytics-recent-${days}`}
                  className={controlClass}
                  onClick={() => query(recentAnalyticsRange(days))}
                >
                  {t('analytics_recent_days', { count: days })}
                </button>
              ))}
              <span className="text-xs text-text-secondary">{t('analytics_timezone')}</span>
            </div>
            <p
              id="site-analytics-range-hint"
              className={`mt-2 text-xs ${valid ? 'text-text-secondary' : 'text-danger'}`}
              role={valid ? undefined : 'alert'}
            >
              {t(valid ? 'analytics_range_hint' : 'analytics_invalid_range')}
            </p>
          </form>
          <div className="mt-5" aria-busy={loading}>
            {loading && (
              <p role="status" className="flex items-center gap-2 py-8 text-sm text-text-secondary">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t('analytics_loading')}
              </p>
            )}
            {error && (
              <div className="py-6">
                <p role="alert" className="text-sm text-danger">
                  {t(error)}
                </p>
                <button
                  type="button"
                  data-testid="site-analytics-retry"
                  className={`${controlClass} mt-3`}
                  onClick={() => query(request.range)}
                >
                  {t('analytics_retry')}
                </button>
              </div>
            )}
            {data && (
              <>
                <p
                  className="text-xs text-text-secondary"
                  data-testid="site-analytics-result-range"
                >
                  {data.start_date} — {data.end_date}
                </p>
                <dl className="mt-3 grid grid-cols-2 gap-4" data-testid="site-analytics-totals">
                  <div>
                    <dt className="text-sm text-text-secondary">{t('analytics_total_pv')}</dt>
                    <dd className="mt-1 text-heading-md font-medium">
                      {data.totals.pv.toLocaleString()}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-sm text-text-secondary">{t('analytics_total_uv')}</dt>
                    <dd className="mt-1 text-heading-md font-medium">
                      {data.totals.uv.toLocaleString()}
                    </dd>
                  </div>
                </dl>
                {data.end_date === today && (
                  <p className="mt-3 text-xs text-text-secondary">
                    {t('analytics_today_incomplete')}
                  </p>
                )}
                {data.totals.pv === 0 ? (
                  <p role="status" className="mt-4 text-sm text-text-secondary">
                    {t('analytics_empty')}
                  </p>
                ) : (
                  <AnalyticsTrend data={data} label={t('analytics_trend')} />
                )}
                <table className="mt-4 w-full text-left text-sm" data-testid="site-analytics-daily">
                  <caption className="sr-only">{t('analytics_daily')}</caption>
                  <thead>
                    <tr className="border-b border-border text-text-secondary">
                      <th scope="col" className="py-2 font-medium">
                        {t('analytics_date')}
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        PV
                      </th>
                      <th scope="col" className="py-2 text-right font-medium">
                        UV
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily
                      .slice()
                      .reverse()
                      .map(day => (
                        <tr key={day.date} className="border-b border-border/50">
                          <th scope="row" className="py-2 font-normal">
                            {day.date}
                          </th>
                          <td className="py-2 text-right tabular-nums">
                            {day.pv.toLocaleString()}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {day.uv.toLocaleString()}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="mt-3 text-xs text-text-secondary">{t('analytics_uv_hint')}</p>
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function AnalyticsTrend({ data, label }: { data: SiteAnalytics; label: string }) {
  const max = Math.max(1, ...data.daily.map(day => day.pv))
  const x = (index: number) =>
    data.daily.length === 1 ? 320 : 24 + (index * 592) / (data.daily.length - 1)
  const y = (value: number) => 112 - (value / max) * 96
  return (
    <figure className="mt-4" data-testid="site-analytics-trend">
      <figcaption className="flex items-center gap-4 text-xs text-text-secondary">
        <span>{label}</span>
        <span>— PV</span>
        <span>┄ UV</span>
      </figcaption>
      <svg
        viewBox="0 0 640 136"
        role="img"
        aria-label={label}
        className="mt-2 w-full text-text-primary"
      >
        <line x1="24" y1="112" x2="616" y2="112" stroke="currentColor" opacity="0.15" />
        {(['pv', 'uv'] as const).map(metric => (
          <g key={metric} opacity={metric === 'uv' ? 0.6 : 1}>
            <polyline
              points={data.daily.map((day, index) => `${x(index)},${y(day[metric])}`).join(' ')}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeDasharray={metric === 'uv' ? '5 4' : undefined}
            />
            {data.daily.map((day, index) => (
              <circle key={day.date} cx={x(index)} cy={y(day[metric])} r="3" fill="currentColor">
                <title>
                  {day.date}: {metric.toUpperCase()} {day[metric]}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <div className="flex justify-between text-xs text-text-secondary">
        <span>{data.start_date}</span>
        <span>{data.end_date}</span>
      </div>
    </figure>
  )
}
