import { Plus } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useCallback, useRef } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface AddContextMenuProps {
  disabled: boolean
  onFileSelect: (files: File | File[]) => void
}

export function AddContextMenu({ disabled, onFileSelect }: AddContextMenuProps) {
  const { t } = useTranslation('common')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) onFileSelect(Array.from(files))
      event.target.value = ''
    },
    [onFileSelect]
  )

  return (
    <div className="relative">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="attachment-file-input"
        onChange={handleFileChange}
      />
      <button
        type="button"
        data-testid="add-context-button"
        onClick={() => fileInputRef.current?.click()}
        disabled={disabled}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary/85 hover:bg-background/70 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
        aria-label={t('workbench.add_photos_files', '添加照片和文件')}
        title={t('workbench.add_photos_files', '添加照片和文件')}
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
