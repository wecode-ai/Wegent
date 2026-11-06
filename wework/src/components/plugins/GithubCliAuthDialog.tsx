import { createPortal } from 'react-dom'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'
import type {
  LocalConnectorAuthTarget,
  LocalConnectorAuthTransport,
} from '@/api/local/localConnectorAuth'

export function GithubCliAuthDialog({
  onSuccess,
  onCancel,
  target = GITHUB_CLI_TARGET,
  transport,
  title,
  testId = 'plugin-github-cli-auth-dialog',
}: {
  onSuccess: () => void
  onCancel: () => void
  target?: LocalConnectorAuthTarget
  transport?: LocalConnectorAuthTransport
  title?: string
  testId?: string
}) {
  const { t } = useTranslation()
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onCancel)
  return createPortal(
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title || t('workbench.github_cli_login_title')}
        data-testid={testId}
      >
        <ConnectorAuthCard
          target={target}
          transport={transport}
          title={title || t('workbench.github_cli_login_title')}
          description={
            target.pluginKey === 'github'
              ? t('workbench.github_cli_login_description')
              : t('standIn.git.gitlab_login_description')
          }
          onSuccess={onSuccess}
          onCancel={onCancel}
        />
      </div>
    </div>,
    document.body
  )
}
