import { Paperclip, Plus } from 'lucide-react'
import type { ChangeEvent } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SUPPORTED_EXTENSIONS } from '@/api/attachments'
import { useOutsideClick } from './useOutsideClick'

interface AddContextMenuProps {
  disabled: boolean
  onFileSelect: (files: File | File[]) => void
}

export function AddContextMenu({ disabled, onFileSelect }: AddContextMenuProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)

  const handleFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files
      if (files && files.length > 0) {
        onFileSelect(Array.from(files))
      }
      event.target.value = ''
      setOpen(false)
    },
    [onFileSelect]
  )

  return (
    <div ref={containerRef} className="relative">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={SUPPORTED_EXTENSIONS.join(',')}
        className="hidden"
        data-testid="attachment-file-input"
        onChange={handleFileChange}
      />
      {open && (
        <div
          data-testid="add-context-menu"
          className="absolute bottom-[44px] left-0 z-40 w-60 overflow-hidden rounded-xl border border-border bg-background p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]"
        >
          <button
            type="button"
            data-testid="attach-files-button"
            onClick={() => fileInputRef.current?.click()}
            className="flex h-9 w-full items-center gap-2.5 rounded-lg px-3 text-left text-[13px] font-medium leading-[18px] text-text-primary hover:bg-muted"
          >
            <Paperclip className="h-[18px] w-[18px] shrink-0 text-text-secondary" />
            <span>{t('workbench.add_photos_files', '添加照片和文件')}</span>
          </button>
        </div>
      )}
      <button
        type="button"
        data-testid="add-context-button"
        onClick={() => !disabled && setOpen(current => !current)}
        disabled={disabled}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full p-0 text-text-secondary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        aria-expanded={open}
        aria-label={t('workbench.add_context', '添加上下文')}
      >
        <Plus className="h-5 w-5" />
      </button>
    </div>
  )
}
