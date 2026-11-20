import { useRef } from 'react'
import { Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'

export function SmartAppFilePicker({
  accept,
  emptyText,
  files,
  inputTestId,
  label,
  multiple = false,
  onChange,
}: {
  accept: string
  emptyText?: string
  files: File[]
  inputTestId: string
  label: string
  multiple?: boolean
  onChange: (files: File[]) => void
}) {
  const { t } = useTranslation('common')
  const inputRef = useRef<HTMLInputElement>(null)
  const selectionText =
    files.length === 0
      ? (emptyText ?? t('workbench.smart_apps_no_file_selected', '未选择文件'))
      : files.length === 1
        ? files[0].name
        : t('workbench.smart_apps_files_selected', '已选择 {{count}} 个文件').replace(
            '{{count}}',
            String(files.length)
          )

  return (
    <div className="mt-2 flex min-w-0 items-center gap-3">
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-11 shrink-0 md:h-9"
        data-testid={`${inputTestId}-trigger`}
        onClick={() => inputRef.current?.click()}
      >
        <Upload className="h-4 w-4" />
        {t('workbench.smart_apps_choose_file', '选择文件')}
      </Button>
      <span
        className="min-w-0 break-all text-sm font-normal text-text-secondary"
        data-testid={`${inputTestId}-selection`}
      >
        {selectionText}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        aria-label={label}
        data-testid={inputTestId}
        className="sr-only"
        onChange={event => {
          onChange(Array.from(event.target.files ?? []))
          event.target.value = ''
        }}
      />
    </div>
  )
}
