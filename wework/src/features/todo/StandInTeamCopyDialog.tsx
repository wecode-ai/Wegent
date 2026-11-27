import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useTranslation } from '@/hooks/useTranslation'

export function StandInTeamCopyDialog({
  open,
  onClose,
  onConfirm,
}: {
  open: boolean
  onClose(): void
  onConfirm(): void
}) {
  const { t } = useTranslation('common')
  return (
    <ConfirmDialog
      open={open}
      title={t('standIn.personal.copy_team_title')}
      description={t('standIn.personal.copy_team_description')}
      cancelLabel={t('standIn.personal.keep_editing')}
      confirmLabel={t('standIn.personal.copy_team_save')}
      confirmTestId="stand-in-copy-team-confirm"
      cancelTestId="stand-in-copy-team-cancel"
      onClose={onClose}
      onConfirm={onConfirm}
    />
  )
}
