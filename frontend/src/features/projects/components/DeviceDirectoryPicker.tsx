// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, Folder, FolderOpen, Loader2, RefreshCw } from 'lucide-react'

import { deviceApis } from '@/apis/devices'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

const DIRECTORY_COMMAND_TIMEOUT_SECONDS = 15

interface DeviceDirectoryPickerProps {
  deviceId: string
  value: string
  onChange: (path: string) => void
  disabled?: boolean
}

function commandOutputToString(stdout: string | string[]): string {
  return Array.isArray(stdout) ? stdout.join('\n') : stdout
}

function commandOutputToList(stdout: string | string[]): string[] {
  if (Array.isArray(stdout)) {
    return stdout.filter(Boolean)
  }
  return stdout
    .split('\n')
    .map(item => item.trim())
    .filter(Boolean)
}

function getPathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

function stripTrailingSeparators(path: string): string {
  if (path === '/' || /^[a-zA-Z]:[\\/]$/.test(path)) {
    return path
  }
  return path.replace(/[\\/]+$/, '')
}

function getDirectoryName(path: string): string {
  const trimmed = stripTrailingSeparators(path)
  return trimmed.split(/[\\/]/).filter(Boolean).pop() || trimmed
}

function joinPath(basePath: string, directoryName: string): string {
  const separator = getPathSeparator(basePath)
  const normalizedBase = stripTrailingSeparators(basePath)
  if (!normalizedBase || normalizedBase === separator) {
    return `${separator}${directoryName}`
  }
  return `${normalizedBase}${separator}${directoryName}`
}

function getParentPath(path: string): string | null {
  const normalized = stripTrailingSeparators(path)
  if (!normalized || normalized === '/') {
    return null
  }
  if (/^[a-zA-Z]:[\\/]?$/.test(normalized)) {
    return null
  }

  const separator = getPathSeparator(normalized)
  const lastSeparatorIndex = normalized.lastIndexOf(separator)
  if (lastSeparatorIndex < 0) {
    return null
  }
  if (lastSeparatorIndex === 0) {
    return '/'
  }
  if (/^[a-zA-Z]:[\\/]/.test(normalized) && lastSeparatorIndex === 2) {
    return normalized.slice(0, 3)
  }
  return normalized.slice(0, lastSeparatorIndex)
}

function sortDirectories(directories: string[]): string[] {
  return [...directories].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: 'base' })
  )
}

export function DeviceDirectoryPicker({
  deviceId,
  value,
  onChange,
  disabled,
}: DeviceDirectoryPickerProps) {
  const { t } = useTranslation('projects')
  const [open, setOpen] = useState(false)
  const [currentPath, setCurrentPath] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedName = useMemo(() => (value ? getDirectoryName(value) : ''), [value])
  const parentPath = useMemo(() => getParentPath(currentPath), [currentPath])

  const loadDirectories = useCallback(
    async (path: string) => {
      if (!deviceId) return

      setIsLoading(true)
      setError(null)
      try {
        const response = await deviceApis.executeCommand(deviceId, {
          command_key: 'list_directories',
          path,
          timeout_seconds: DIRECTORY_COMMAND_TIMEOUT_SECONDS,
        })
        if (!response.success) {
          throw new Error(response.error || response.stderr || t('workspace.directoryLoadFailed'))
        }

        setCurrentPath(path)
        setDirectories(sortDirectories(commandOutputToList(response.stdout)))
      } catch (err) {
        const message = err instanceof Error ? err.message : t('workspace.directoryLoadFailed')
        setError(message)
        setDirectories([])
      } finally {
        setIsLoading(false)
      }
    },
    [deviceId, t]
  )

  useEffect(() => {
    if (!open || !deviceId) return

    let cancelled = false

    const loadInitialDirectory = async () => {
      setIsLoading(true)
      setError(null)
      try {
        let initialPath = value.trim()
        if (!initialPath) {
          const response = await deviceApis.executeCommand(deviceId, {
            command_key: 'pwd',
            timeout_seconds: DIRECTORY_COMMAND_TIMEOUT_SECONDS,
          })
          if (!response.success) {
            throw new Error(response.error || response.stderr || t('workspace.directoryLoadFailed'))
          }
          initialPath = commandOutputToString(response.stdout).split('\n')[0]?.trim() || ''
        }
        if (!initialPath) {
          throw new Error(t('workspace.directoryLoadFailed'))
        }
        if (!cancelled) {
          await loadDirectories(initialPath)
        }
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : t('workspace.directoryLoadFailed')
          setError(message)
          setDirectories([])
          setIsLoading(false)
        }
      }
    }

    void loadInitialDirectory()

    return () => {
      cancelled = true
    }
  }, [deviceId, loadDirectories, open, t, value])

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setError(null)
    }
  }

  const handleSelectCurrent = () => {
    if (!currentPath) return
    onChange(currentPath)
    setOpen(false)
  }

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="h-11 w-full justify-start px-3"
        disabled={disabled || !deviceId}
        onClick={() => setOpen(true)}
        data-testid="workspace-local-path-input"
      >
        <FolderOpen className="h-4 w-4 shrink-0 text-text-secondary" />
        <span className={cn('truncate', !value && 'text-text-muted')}>
          {value || t('workspace.directoryPickerPlaceholder')}
        </span>
      </Button>

      {selectedName && (
        <p className="text-xs text-text-secondary">
          {t('workspace.projectNamePreview', { name: selectedName })}
        </p>
      )}

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>{t('workspace.directoryPickerTitle')}</DialogTitle>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={!parentPath || isLoading}
                onClick={() => parentPath && void loadDirectories(parentPath)}
                data-testid="workspace-directory-parent-button"
                title={t('workspace.directoryParent')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <div
                className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2"
                data-testid="workspace-directory-current-path"
              >
                <p className="truncate font-mono text-xs text-text-primary">
                  {currentPath || t('workspace.directoryLoading')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-11 w-11 shrink-0"
                disabled={!currentPath || isLoading}
                onClick={() => void loadDirectories(currentPath)}
                data-testid="workspace-directory-refresh-button"
                title={t('workspace.directoryRefresh')}
              >
                <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
              </Button>
            </div>

            <div className="h-72 overflow-y-auto rounded-md border border-border bg-base">
              {isLoading ? (
                <div className="flex h-full items-center justify-center text-sm text-text-muted">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('workspace.directoryLoading')}
                </div>
              ) : error ? (
                <div
                  className="flex h-full items-center justify-center px-4 text-center text-sm text-destructive"
                  data-testid="workspace-directory-error"
                >
                  {error}
                </div>
              ) : directories.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-text-muted">
                  {t('workspace.directoryEmpty')}
                </div>
              ) : (
                <div className="py-1">
                  {directories.map(directory => (
                    <button
                      key={directory}
                      type="button"
                      className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-text-primary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      onClick={() => void loadDirectories(joinPath(currentPath, directory))}
                      data-testid="workspace-directory-item"
                    >
                      <Folder className="h-4 w-4 shrink-0 text-primary" />
                      <span className="truncate">{directory}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('create.cancel')}
            </Button>
            <Button
              type="button"
              variant="primary"
              disabled={!currentPath || isLoading}
              onClick={handleSelectCurrent}
              data-testid="workspace-directory-select-button"
            >
              <Check className="h-4 w-4" />
              {t('workspace.directorySelect')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
