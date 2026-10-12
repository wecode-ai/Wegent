import { Loader2 } from 'lucide-react'

import { type LocalCodexAccounts } from '@/api/local/codexAuth'
import { type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'

import { useTranslation } from '@/hooks/useTranslation'

export function LocalCodexModelRow({
  status,
  accounts,
  loading,
  error,
  loginState,
  loginError,
  switchingAccountId,
  onLogin,
  onCancelLogin,
  onSwitchAccount,
}: {
  status: LocalRuntimeAuthStatus | null
  accounts: LocalCodexAccounts | null
  loading: boolean
  error: string | null
  loginState: 'idle' | 'starting' | 'waiting' | 'cancelling'
  loginError: string | null
  switchingAccountId: string | null
  onLogin: () => void
  onCancelLogin: () => void
  onSwitchAccount: (accountId: string) => void
}) {
  const { t } = useTranslation('common')
  const exists = status?.exists === true
  const activeAccount = accounts?.accounts.find(account => account.id === accounts.activeAccountId)
  const loginBusy = loginState !== 'idle'
  return (
    <div
      data-testid="local-codex-model-row"
      className="rounded-lg border border-border bg-background px-3 py-2.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('workbench.local_codex_model_title', 'Codex 账号')}
            </h3>
            <span
              data-testid="local-codex-model-status-pill"
              className={`rounded-full px-2 py-0.5 text-xs ${
                exists ? 'bg-primary/10 text-primary' : 'bg-muted text-text-muted'
              }`}
            >
              {loading
                ? t('workbench.local_codex_account_checking', '检查中')
                : exists
                  ? t('workbench.local_codex_account_signed_in', '已登录')
                  : t('workbench.local_codex_account_signed_out', '未登录')}
            </span>
          </div>
          <div className="mt-1 text-xs leading-5 text-text-secondary">
            {loading
              ? t('workbench.local_codex_account_checking_description', '正在检查账号状态...')
              : loginState === 'waiting' || loginState === 'cancelling'
                ? t(
                    'workbench.local_codex_login_waiting',
                    '请在浏览器中完成登录，完成后这里会自动更新。'
                  )
                : activeAccount?.email ||
                  (exists
                    ? t(
                        'workbench.local_codex_account_signed_in_description',
                        '当前设备已可使用 Codex。'
                      )
                    : t(
                        'workbench.local_codex_account_signed_out_description',
                        '登录 ChatGPT 账号以在 Wework 中使用 Codex。'
                      ))}
          </div>
          {error && <div className="mt-1 text-xs text-red-500">{error}</div>}
          {loginError && (
            <div data-testid="local-codex-login-error" className="mt-1 text-xs text-red-500">
              {loginError}
            </div>
          )}
        </div>
        {!loading && (
          <div className="flex items-center gap-2">
            {loginState === 'waiting' || loginState === 'cancelling' ? (
              <button
                type="button"
                data-testid="local-codex-login-cancel-button"
                onClick={onCancelLogin}
                disabled={loginState === 'cancelling'}
                className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loginState === 'cancelling' && (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                )}
                {t('workbench.local_codex_login_cancel', '取消登录')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="local-codex-login-button"
                onClick={onLogin}
                disabled={loginState === 'starting'}
                className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loginState === 'starting' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : null}
                {loginState === 'starting'
                  ? t('workbench.local_codex_login_opening', '正在打开...')
                  : exists
                    ? t('workbench.local_codex_add_account', '添加账号')
                    : t('workbench.local_codex_login_action', '登录')}
              </button>
            )}
          </div>
        )}
      </div>
      {!loading && accounts && accounts.accounts.length > 0 && (
        <div data-testid="local-codex-account-list" className="mt-3 grid gap-1">
          {accounts.accounts.map(account => {
            const active = account.id === accounts.activeAccountId
            const switching = account.id === switchingAccountId
            return (
              <div
                key={account.id}
                data-testid={`local-codex-account-${account.id}`}
                className="flex min-h-10 items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-text-primary">
                    {account.email || t('workbench.local_codex_account_unknown', 'ChatGPT 账号')}
                  </div>
                  {account.planType && (
                    <div className="text-xs text-text-muted">{account.planType}</div>
                  )}
                </div>
                {active ? (
                  <span className="shrink-0 text-xs text-text-muted">
                    {t('workbench.local_codex_account_current', '当前账号')}
                  </span>
                ) : (
                  <button
                    type="button"
                    data-testid={`local-codex-account-switch-${account.id}`}
                    onClick={() => onSwitchAccount(account.id)}
                    disabled={loginBusy || switchingAccountId !== null}
                    className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {switching && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    {t('workbench.local_codex_account_switch', '切换')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
