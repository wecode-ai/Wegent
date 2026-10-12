import { createPortal } from 'react-dom'
import { ConnectorAuthCard } from '@/components/chat/ConnectorAuthCard'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { GITHUB_CLI_TARGET } from '@/api/local/githubCli'

export function GithubCliAuthDialog({
  onSuccess,
  onCancel,
}: {
  onSuccess: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onCancel)
  return createPortal(
    <div className="plugin-dialog-overlay fixed inset-0 z-modal flex items-center justify-center px-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.github_cli_login_title')}
        data-testid="plugin-github-cli-auth-dialog"
      >
        <ConnectorAuthCard
          target={GITHUB_CLI_TARGET}
          title={t('workbench.github_cli_login_title')}
          description={t('workbench.github_cli_login_description')}
          onSuccess={onSuccess}
          onCancel={onCancel}
        />
      </div>
    </div>,
    document.body
  )
}
