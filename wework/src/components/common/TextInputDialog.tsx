import { useTranslation } from '@/hooks/useTranslation'
import {
  TextInputDialog as SharedTextInputDialog,
  type TextInputDialogProps,
} from '@wegent/collaboration/controls/TextInputDialog'

type LocalTextInputDialogProps = Omit<TextInputDialogProps, 'failedLabel'>

export function TextInputDialog(props: LocalTextInputDialogProps) {
  return props.open ? <LocalizedTextInputDialog {...props} /> : null
}

function LocalizedTextInputDialog(props: LocalTextInputDialogProps) {
  const { t } = useTranslation('common')
  return <SharedTextInputDialog {...props} failedLabel={t('workbench.save_failed', '保存失败')} />
}
