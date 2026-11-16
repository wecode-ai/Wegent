import { useEffect, useMemo, useState } from 'react'
import { dequal } from 'dequal'
import type { StandInExecutorApi, StandInMemoryRule, StandInMemoryScope } from '@/api/standIn'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'

export function StandInMemoryRules({
  api,
  userId,
  deviceId,
  fixedScope,
  label,
  refreshKey,
  disabled,
  onBusyChange,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  fixedScope?: StandInMemoryScope
  label(scope: StandInMemoryScope): string
  refreshKey: unknown
  disabled: boolean
  onBusyChange(busy: boolean): void
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [retry, setRetry] = useState(0)
  const scopeKey = fixedScope ? JSON.stringify(fixedScope) : undefined
  const owner = useMemo(
    () => ({ api, userId, deviceId, scopeKey }),
    [api, userId, deviceId, scopeKey]
  )
  const [state, setState] = useState<{
    owner: object
    items: StandInMemoryRule[] | null
    error: string | null
    loading: boolean
  }>({ owner, items: null, error: null, loading: false })
  const [deleting, setDeleting] = useState<{ owner: object; row: StandInMemoryRule } | null>(null)
  const [notice, setNotice] = useState<{ owner: object; text: string } | null>(null)
  const current = state.owner === owner ? state : null
  const selected = deleting?.owner === owner ? deleting.row : null
  useEffect(() => {
    if (!open) return
    let active = true
    setState(previous => ({
      owner,
      items: previous.owner === owner ? previous.items : null,
      error: null,
      loading: true,
    }))
    api
      .memoryRules(userId, deviceId)
      .then(rows => {
        if (!active) return
        const items = rows.filter(row =>
          row.kind === 'legacy_fingerprint'
            ? !scopeKey
            : scopeKey
              ? dequal(row.scope, JSON.parse(scopeKey))
              : row.scope.kind !== 'project_coordinator'
        )
        setState({ owner, items, error: null, loading: false })
      })
      .catch(error => {
        if (active)
          setState(previous => ({
            ...previous,
            error: getStandInErrorMessage(error),
            loading: false,
          }))
      })
    return () => {
      active = false
    }
  }, [api, userId, deviceId, scopeKey, owner, open, retry, refreshKey])

  const remove = async (row: StandInMemoryRule) => {
    onBusyChange(true)
    setNotice(null)
    try {
      if (row.kind === 'legacy_fingerprint') {
        await api.deleteMemoryRule(userId, deviceId, row.id, row.version, row.updatedAt)
      } else {
        await api.deleteMemoryRule(userId, deviceId, row.id, row.version)
      }
      setState(previous =>
        previous.owner === owner
          ? {
              ...previous,
              items: previous.items?.filter(item => item.id !== row.id) ?? [],
              error: null,
            }
          : previous
      )
      setDeleting(null)
      setNotice({
        owner,
        text: t(
          row.kind === 'legacy_fingerprint'
            ? 'standIn.memory.legacy_rule_deleted'
            : 'standIn.memory.rule_deleted'
        ),
      })
    } catch (error) {
      setState(previous =>
        previous.owner === owner ? { ...previous, error: getStandInErrorMessage(error) } : previous
      )
    } finally {
      onBusyChange(false)
    }
  }

  return (
    <section className="mt-6 border-t border-border py-4" data-testid="stand-in-memory-rules">
      <Button
        variant="ghost"
        className="min-h-11 md:min-h-8"
        aria-expanded={open}
        aria-controls="stand-in-memory-rules-content"
        data-testid="stand-in-memory-rules-toggle"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
      >
        {t('standIn.memory.rules_title')}
      </Button>
      {open && (
        <div id="stand-in-memory-rules-content" className="mt-3">
          <p className="text-sm text-text-muted">{t('standIn.memory.rules_help')}</p>
          {current?.error && (
            <div role="alert" className="mt-3 text-sm text-error">
              <p>{current.error}</p>
              <Button
                variant="ghost"
                className="min-h-11 md:min-h-8"
                disabled={disabled || current.loading}
                data-testid="stand-in-memory-rules-retry"
                onClick={() => {
                  setDeleting(null)
                  setRetry(value => value + 1)
                }}
              >
                {t('standIn.reload')}
              </Button>
            </div>
          )}
          {(!current || current.loading) && (
            <p role="status" className="mt-3 text-sm">
              {t('standIn.loading')}
            </p>
          )}
          {current?.items?.length === 0 && !current.error && !current.loading && (
            <p className="mt-3 text-sm text-text-muted">{t('standIn.memory.rules_empty')}</p>
          )}
          {notice?.owner === owner && (
            <p role="status" className="mt-3 text-sm">
              {notice.text}
            </p>
          )}
          <ul className="divide-y divide-border">
            {current?.items?.map(row => (
              <li
                key={row.id}
                className="py-4"
                data-testid="stand-in-memory-rule"
                data-rule-id={row.id}
              >
                <p className="text-xs text-text-muted">
                  {t(
                    row.kind === 'legacy_fingerprint'
                      ? 'standIn.memory.legacy_rule_title'
                      : 'standIn.memory.rule_target'
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                  {row.kind === 'legacy_fingerprint'
                    ? t('standIn.memory.legacy_rule_help')
                    : row.content}
                </p>
                <p className="mt-2 text-xs text-text-muted">
                  {row.kind === 'legacy_fingerprint'
                    ? t('standIn.memory.legacy_rule_scope')
                    : label(row.scope)}{' '}
                  · {new Date(row.updatedAt).toLocaleString()}
                  {row.kind === 'legacy_fingerprint' && ` · ${row.id.slice(-12)}`}
                </p>
                {selected?.id === row.id ? (
                  <div className="mt-3">
                    <p className="text-sm" id={`forgetting-rule-warning-${row.id}`}>
                      {t(
                        row.kind === 'legacy_fingerprint'
                          ? 'standIn.memory.legacy_rule_delete_help'
                          : 'standIn.memory.rule_delete_help'
                      )}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <Button
                        variant="ghost"
                        className="min-h-11 md:min-h-8"
                        disabled={disabled || current.loading || !!current.error}
                        aria-describedby={`forgetting-rule-warning-${row.id}`}
                        data-testid="stand-in-memory-rule-delete-confirm"
                        onClick={() => void remove(row)}
                      >
                        {t('standIn.memory.rule_delete_confirm')}
                      </Button>
                      <Button
                        variant="ghost"
                        className="min-h-11 md:min-h-8"
                        disabled={disabled}
                        data-testid="stand-in-memory-rule-delete-cancel"
                        onClick={() => setDeleting(null)}
                      >
                        {t('standIn.cancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    className="mt-2 min-h-11 md:min-h-8"
                    disabled={disabled || current.loading || !!current.error}
                    data-testid="stand-in-memory-rule-delete"
                    onClick={() => setDeleting({ owner, row })}
                  >
                    {t('standIn.memory.rule_delete')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  )
}
