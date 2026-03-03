'use client'

import { ComputerDesktopIcon } from '@heroicons/react/24/outline'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import '@wecode/i18n'

interface VncToggleProps {
  readonly isOpen: boolean
  readonly onToggle: () => void
  readonly className?: string
}

export function VncToggle({ isOpen, onToggle, className = '' }: VncToggleProps) {
  const { t } = useTranslation('devices')
  const isMobile = useIsMobile()

  if (isMobile) {
    return null
  }

  return (
    <button
      onClick={onToggle}
      className={`relative w-8 h-8 rounded-[7px] border transition-all duration-200 ${
        isOpen
          ? 'bg-primary/10 border-primary/30 text-primary'
          : 'bg-base border-border text-text-primary hover:bg-hover'
      } ${className}`}
      title={isOpen ? t('vnc_close') : t('vnc_open_desktop')}
    >
      <ComputerDesktopIcon className="w-4 h-4 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
    </button>
  )
}

export default VncToggle
