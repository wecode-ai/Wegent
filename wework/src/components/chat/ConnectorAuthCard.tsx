import { ExternalLink, Loader2, QrCode } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { openExternalUrl } from '@/lib/external-links'
import { githubVerificationUrl, isGithubCliTarget } from '@/api/local/githubCli'
import { gitlabVerificationUrl, isGitlabCliTarget } from '@/api/local/gitlabCli'
import { useTranslation } from '@/hooks/useTranslation'
import type {
  LocalConnectorAuthResult,
  LocalConnectorAuthTarget,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'
import { useLocalConnectorAuthSession } from '@/features/plugins/useLocalConnectorAuthSession'

interface ConnectorAuthCardProps {
  transport?: LocalConnectorAuthTransport
  target: LocalConnectorAuthTarget
  title?: string
  description?: string
  onSuccess: (result: LocalConnectorAuthResult) => void
  onCancel?: () => void
}

export function ConnectorAuthCard(props: ConnectorAuthCardProps) {
  return (
    <ConnectorAuthCardSession
      key={`${props.target.pluginKey}:${props.target.connectorSlug}`}
      {...props}
    />
  )
}

function ConnectorAuthCardSession({
  target,
  title,
  description,
  onSuccess,
  onCancel,
  transport,
}: ConnectorAuthCardProps) {
  const { t } = useTranslation('common')
  const githubCli = isGithubCliTarget(target)
  const deviceCli = githubCli || isGitlabCliTarget(target)
  const prefix = githubCli ? 'github-cli' : 'gitlab-cli'
  const [loginRequested, setLoginRequested] = useState(!deviceCli)
  const [openFailed, setOpenFailed] = useState(false)
  const {
    status,
    error,
    busy,
    usesBrowser,
    statusText,
    qrSrc,
    canRetry,
    retry,
    cancelActiveSession,
  } = useLocalConnectorAuthSession({
    enabled: loginRequested,
    target,
    t,
    onSuccess,
    transport,
  })
  const verificationUrl =
    !error && status?.status === 'waiting_browser'
      ? githubCli
        ? githubVerificationUrl(status.verificationUrl, status.userCode)
        : gitlabVerificationUrl(target, status.verificationUrl)
      : null

  const handleCancel = () => {
    cancelActiveSession()
    onCancel?.()
  }

  return (
    <div
      className="mb-3 max-w-md rounded-2xl border bg-background p-4 shadow-sm"
      data-testid="connector-auth-card"
    >
      <div className="mb-3">
        <h3 className="text-sm font-semibold">
          {title ||
            (usesBrowser
              ? t('workbench.plugins_local_browser_title', '在浏览器中授权')
              : t('workbench.plugins_local_qr_title', '扫码登录'))}
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {description ||
            t(
              'workbench.connector_auth_description',
              '登录完成后会自动继续当前任务，无需在对话里输入“继续”。'
            )}
        </p>
      </div>
      <div className="flex flex-col items-center gap-3 rounded-xl bg-muted/30 p-4">
        {deviceCli ? (
          <div
            className="flex flex-col items-center gap-3 text-center"
            data-testid={`${prefix}-auth`}
          >
            <p className="text-sm">
              {t(
                githubCli
                  ? 'workbench.github_cli_login_description'
                  : 'standIn.git.gitlab_login_description'
              )}
            </p>
            {status?.userCode ? (
              <code className="select-text text-code" data-testid={`${prefix}-device-code`}>
                {status.userCode}
              </code>
            ) : null}
            {!loginRequested ? (
              <Button data-testid={`${prefix}-login`} onClick={() => setLoginRequested(true)}>
                {t(githubCli ? 'workbench.github_cli_login' : 'standIn.git.login')}
              </Button>
            ) : verificationUrl ? (
              <Button
                data-testid={`${prefix}-open-browser`}
                onClick={async () => {
                  setOpenFailed(false)
                  try {
                    const opened = await openExternalUrl(verificationUrl, { target: 'system' })
                    if (opened === false) setOpenFailed(true)
                  } catch {
                    setOpenFailed(true)
                  }
                }}
              >
                {t('workbench.github_cli_open_browser')}
              </Button>
            ) : busy || !status ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            {openFailed ? (
              <p className="text-sm text-destructive" role="alert">
                {t('workbench.github_cli_browser_failed')}
              </p>
            ) : null}
          </div>
        ) : usesBrowser ? (
          <div
            className="flex h-52 w-52 flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-background"
            data-testid="connector-auth-browser"
          >
            {status?.status === 'waiting_browser' ? (
              <ExternalLink className="h-7 w-7 text-muted-foreground" />
            ) : busy || !status ? (
              <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
            ) : (
              <ExternalLink className="h-7 w-7 text-muted-foreground" />
            )}
          </div>
        ) : qrSrc && !error ? (
          <img
            src={qrSrc}
            alt="Login QR code"
            className="h-52 w-52 rounded-lg bg-white p-2"
            data-testid="connector-auth-qr"
          />
        ) : error ? (
          <div className="flex h-52 w-52 flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background p-3 text-center">
            <QrCode className="h-7 w-7 text-muted-foreground" />
            <p className="text-xs text-destructive" data-testid="connector-auth-error">
              {error}
            </p>
          </div>
        ) : (
          <div className="flex h-52 w-52 items-center justify-center rounded-lg border border-dashed bg-background">
            <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
          </div>
        )}
        {!deviceCli || loginRequested ? (
          <div className="flex items-center gap-2 text-sm" role="status">
            {usesBrowser ? (
              <ExternalLink className="h-4 w-4 text-muted-foreground" />
            ) : (
              <QrCode className="h-4 w-4 text-muted-foreground" />
            )}
            <span>
              {githubCli && status?.errorCode
                ? t(`workbench.${status.errorCode}`, {
                    defaultValue: t('workbench.gh_login_failed'),
                  })
                : statusText}
            </span>
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        {canRetry ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="connector-auth-retry"
            onClick={retry}
          >
            {usesBrowser
              ? t('workbench.plugins_local_browser_retry', '重新授权')
              : t('workbench.retry', '重试')}
          </button>
        ) : null}
        {onCancel ? (
          <button
            type="button"
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
            data-testid="connector-auth-cancel"
            onClick={handleCancel}
          >
            {t('common.cancel', '取消')}
          </button>
        ) : null}
      </div>
    </div>
  )
}
