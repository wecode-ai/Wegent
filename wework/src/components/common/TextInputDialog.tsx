import { useTranslation } from '@/hooks/useTranslation'
import {
  TextInputDialog as SharedTextInputDialog,
  type TextInputDialogProps,
} from '@wegent/collaboration/controls/TextInputDialog'

export function TextInputDialog(props: Omit<TextInputDialogProps, 'failedLabel'>) {
  const { t } = useTranslation('common')
  return <SharedTextInputDialog {...props} failedLabel={t('workbench.save_failed', '保存失败')} />
}
