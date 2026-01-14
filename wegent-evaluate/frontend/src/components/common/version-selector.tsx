'use client'

import { useState, useRef, useEffect } from 'react'
import { useVersion } from '@/contexts/VersionContext'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Check, Calendar, Database } from 'lucide-react'

export function VersionSelector() {
  const { t } = useTranslation()
  const { versions, currentVersion, setCurrentVersion, isLoading } = useVersion()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  if (isLoading) {
    return (
      <button
        disabled
        className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm min-w-[120px] opacity-50"
      >
        <Database className="h-4 w-4" />
        {t('version.loading', 'Loading...')}
      </button>
    )
  }

  if (!currentVersion || versions.length === 0) {
    return (
      <button
        disabled
        className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm min-w-[120px] opacity-50"
      >
        <Database className="h-4 w-4" />
        {t('version.no_versions', 'No versions')}
      </button>
    )
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleDateString()
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-sm min-w-[160px] hover:bg-secondary"
      >
        <Database className="h-4 w-4" />
        <span className="truncate max-w-[100px]">
          {currentVersion.name} ({currentVersion.sync_count}{t('version.sync_count_unit', '条')})
        </span>
        <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 top-full mt-1 w-[280px] rounded-md border bg-card shadow-lg z-50">
          <div className="max-h-[300px] overflow-y-auto py-1">
            {versions.map((version) => (
              <div
                key={version.id}
                onClick={() => {
                  setCurrentVersion(version)
                  setIsOpen(false)
                }}
                className={`px-3 py-2 cursor-pointer hover:bg-secondary ${
                  version.id === currentVersion.id ? 'bg-primary/10' : ''
                }`}
              >
                <div className="flex items-center">
                  {version.id === currentVersion.id ? (
                    <Check className="h-4 w-4 mr-2 text-primary flex-shrink-0" />
                  ) : (
                    <div className="w-6 flex-shrink-0" />
                  )}
                  <span className="font-medium text-sm">
                    {version.name} ({version.sync_count}{t('version.sync_count_unit', '条')})
                  </span>
                </div>
                <div className="flex items-center text-xs text-muted-foreground ml-6 mt-1">
                  <Calendar className="h-3 w-3 mr-1" />
                  {formatDate(version.created_at)}
                  {version.description && (
                    <span className="ml-2 truncate max-w-[120px]">
                      | {version.description}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
