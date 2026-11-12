import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import {
  gitAccountSettingsUrl,
  needsGitConfiguration,
  type GitAccessFailure,
} from '@wegent/chat-core/git-access'
import type { CollaborationTranslate } from '../i18n'
import { Button } from '../markdown/Button'

interface GitAccountConfiguration {
  baseUrl?: string | null
  openUrl(url: string): void | boolean | Promise<unknown>
  canConfigureDevice?(deviceId: string): boolean
}

const Context = createContext<GitAccountConfiguration | null>(null)

export function GitAccountConfigurationProvider({
  value,
  children,
}: {
  value: GitAccountConfiguration | null
  children: ReactNode
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function GitAccountConfigurationButton({
  failure,
  translate,
  testId,
  enabled = true,
  deviceId,
  appearance = 'button',
}: {
  failure?: GitAccessFailure
  translate: CollaborationTranslate
  testId: string
  enabled?: boolean
  deviceId?: string
  appearance?: 'button' | 'text'
}) {
  const configuration = useContext(Context)
  const [opening, setOpening] = useState(false)
  const openingRef = useRef(false)
  const [failedUrl, setFailedUrl] = useState<string>()
  const url = configuration?.baseUrl
    ? gitAccountSettingsUrl({ webUrl: configuration.baseUrl }, failure?.domain)
    : null
  if (!enabled || !needsGitConfiguration(failure) || !url || !configuration) return null
  if (deviceId && configuration.canConfigureDevice?.(deviceId) === false) return null

  async function openSettings() {
    if (openingRef.current || !url || !configuration) return
    openingRef.current = true
    setOpening(true)
    setFailedUrl(undefined)
    try {
      if ((await configuration.openUrl(url)) === false) setFailedUrl(url)
    } catch {
      setFailedUrl(url)
    } finally {
      openingRef.current = false
      setOpening(false)
    }
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={appearance === 'text' ? 'link' : 'outline'}
        className={
          appearance === 'text'
            ? 'h-6 min-h-11 min-w-11 border-0 bg-transparent px-0 text-xs font-normal text-text-secondary hover:text-text-primary md:min-h-6'
            : 'h-8 min-h-11 rounded-lg bg-base text-xs font-semibold text-text-secondary hover:text-text-primary md:min-h-8'
        }
        data-testid={testId}
        disabled={opening}
        onClick={() => void openSettings()}
      >
        {translate('gitAccount.configure', '配置 Git 账户')}
      </Button>
      {failedUrl === url && (
        <span role="alert" className="text-xs text-error" data-testid={`${testId}-error`}>
          {translate('gitAccount.openFailed', '无法打开配置页面，请重试。')}
        </span>
      )}
    </>
  )
}
