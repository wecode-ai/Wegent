import {
  cancelLocalCodexLogin,
  startLocalCodexLogin,
  switchLocalCodexAccount,
  type LocalCodexAccounts,
} from '@/api/local/codexAuth'
import { getLocalCodexAuthStatus, type LocalRuntimeAuthStatus } from '@/api/local/runtimeAuthStatus'
import { openExternalUrl } from '@/lib/external-links'
import { LOCAL_MODEL_SETTINGS_CHANGED_EVENT } from '@/features/model-settings/localModelSettings'
import { invalidateOpenAiRemoteCatalogAccount } from '@/features/plugins/pluginMarketplaceCache'
import type { useTranslation } from '@/hooks/useTranslation'

type Translate = ReturnType<typeof useTranslation>['t']
export interface LocalCodexAuthSnapshot {
  status: LocalRuntimeAuthStatus
  accounts: LocalCodexAccounts
}
interface AccountOperation {
  loginState: 'idle' | 'starting' | 'waiting' | 'cancelling'
  loginError: string | null
  switchingAccountId: string | null
}
const initialOperation: AccountOperation = {
  loginState: 'idle',
  loginError: null,
  switchingAccountId: null,
}
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback

/** Own one settings surface's login process; detached results cannot reopen a login page. */
export function createLocalCodexAccountSession() {
  const listeners = new Set<() => void>()
  let snapshot = initialOperation
  let generation = 0
  let loginId: string | null = null
  let delay: ReturnType<typeof setTimeout> | undefined
  let releaseDelay: (() => void) | undefined
  const publish = (patch: Partial<AccountOperation>) => {
    if (!listeners.size) return
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const current = (version: number) => version === generation && listeners.size > 0
  const stopDelay = () => {
    clearTimeout(delay)
    delay = undefined
    releaseDelay?.()
    releaseDelay = undefined
  }
  const waitForPoll = () =>
    new Promise<void>(resolve => {
      releaseDelay = resolve
      delay = setTimeout(() => {
        delay = undefined
        releaseDelay = undefined
        resolve()
      }, 1000)
    })
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initialOperation,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) {
          generation++
          stopDelay()
          const previous = loginId
          loginId = null
          if (previous) void cancelLocalCodexLogin(previous)
        }
      }
    },
    async login(status: LocalRuntimeAuthStatus | null, reload: () => Promise<void>, t: Translate) {
      if (!listeners.size || snapshot.loginState !== 'idle') return
      const version = ++generation
      publish({ loginState: 'starting', loginError: null })
      try {
        const initialHash = status?.sha256 ?? null
        const login = await startLocalCodexLogin()
        if (!current(version)) {
          void cancelLocalCodexLogin(login.loginId)
          return
        }
        loginId = login.loginId
        const opened = await openExternalUrl(login.authUrl, { target: 'system' })
        if (!current(version)) return
        if (!opened)
          throw new Error(t('workbench.local_codex_login_open_failed', '无法打开 Codex 登录页面'))
        publish({ loginState: 'waiting' })
        const deadline = Date.now() + 5 * 60 * 1000
        while (current(version)) {
          const next = await getLocalCodexAuthStatus()
          if (!current(version)) return
          if (next.exists && next.sha256 && next.sha256 !== initialHash) {
            if (next.catalogScope !== status?.catalogScope) invalidateOpenAiRemoteCatalogAccount()
            loginId = null
            publish({ loginState: 'idle' })
            await reload()
            return
          }
          if (Date.now() >= deadline)
            throw new Error(t('workbench.local_codex_login_timeout', 'Codex 登录已超时，请重试'))
          await waitForPoll()
        }
      } catch (error) {
        if (!current(version)) return
        const previous = loginId
        loginId = null
        if (previous) {
          try {
            await cancelLocalCodexLogin(previous)
          } catch {
            /* Preserve the primary login failure. */
          }
        }
        if (current(version))
          publish({
            loginState: 'idle',
            loginError: errorMessage(
              error,
              t('workbench.local_codex_login_failed', 'Codex 登录失败，请重试')
            ),
          })
      }
    },
    async switchAccount(
      accountId: string,
      accept: (data: LocalCodexAuthSnapshot) => void,
      t: Translate
    ) {
      if (!listeners.size || snapshot.switchingAccountId || snapshot.loginState !== 'idle') return
      publish({ switchingAccountId: accountId, loginError: null })
      try {
        const accounts = await switchLocalCodexAccount(accountId)
        const status = await getLocalCodexAuthStatus()
        if (listeners.size) accept({ status, accounts })
        window.dispatchEvent(new CustomEvent(LOCAL_MODEL_SETTINGS_CHANGED_EVENT))
      } catch (error) {
        publish({
          loginError: errorMessage(
            error,
            t(
              'workbench.local_codex_account_switch_failed',
              '切换失败，请等待正在运行的 Codex 任务结束后重试'
            )
          ),
        })
      } finally {
        publish({ switchingAccountId: null })
      }
    },
    async cancel(t: Translate) {
      if (!loginId || snapshot.loginState !== 'waiting') return
      generation++
      stopDelay()
      const previous = loginId
      loginId = null
      publish({ loginState: 'cancelling', loginError: null })
      try {
        await cancelLocalCodexLogin(previous)
      } catch (error) {
        publish({
          loginError: errorMessage(
            error,
            t('workbench.local_codex_login_cancel_failed', '取消 Codex 登录失败')
          ),
        })
      } finally {
        publish({ loginState: 'idle' })
      }
    },
  }
}
