// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, Folder, Loader2, RefreshCw } from 'lucide-react'

import { deviceApis } from '@/apis/devices'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/hooks/useTranslation'

type ProjectDirectoryPickerDialogProps = {
  open: boolean
  deviceId: string
  initialPath?: string
  onOpenChange: (open: boolean) => void
  onConfirm: (path: string) => void
}

type DirectoryEntry = {
  name: string
  path: string
}

function normalizeDirectoryPath(path: string): string {
  const trimmed = path.trim()
  if (!trimmed || trimmed === '/') return trimmed || '/'
  return trimmed.replace(/\/+$/, '')
}

function joinDirectoryPath(parentPath: string, name: string): string {
  const normalizedParent = normalizeDirectoryPath(parentPath)
  if (!normalizedParent || normalizedParent === '/') return `/${name}`
  return `${normalizedParent}/${name}`
}

function getParentDirectoryPath(path: string): string | null {
  const normalized = normalizeDirectoryPath(path)
  if (!normalized || normalized === '/') return null

  const segments = normalized.split('/').filter(Boolean)
  if (segments.length <= 1) return '/'
  return `/${segments.slice(0, -1).join('/')}`
}

function getStdoutText(stdout: string | string[]): string {
  return Array.isArray(stdout) ? stdout.join('\n') : stdout
}

function getDirectoryNames(stdout: string | string[]): string[] {
  const values = Array.isArray(stdout) ? stdout : stdout.split('\n')
  return values.map(value => value.trim()).filter(value => value && value !== '.' && value !== '..')
}

export function ProjectDirectoryPickerDialog({
  open,
  deviceId,
  initialPath,
  onOpenChange,
  onConfirm,
}: ProjectDirectoryPickerDialogProps) {
  const { t } = useTranslation('projects')
  const directoryLoadError = t('workspace.directoryPicker.error')
  const [currentPath, setCurrentPath] = useState('')
  const [selectedPath, setSelectedPath] = useState('')
  const [directories, setDirectories] = useState<DirectoryEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const parentPath = useMemo(() => getParentDirectoryPath(currentPath), [currentPath])

  const loadDirectories = useCallback(
    async (targetPath: string) => {
      if (!deviceId) return

      const normalizedPath = normalizeDirectoryPath(targetPath)
      setIsLoading(true)
      setError(null)

      try {
        const response = await deviceApis.executeCommand(deviceId, {
          command_key: 'ls_dirs',
          path: normalizedPath,
          timeout_seconds: 20,
          max_output_bytes: 128 * 1024,
        })

        if (!response.success) {
          throw new Error(response.error || response.stderr || directoryLoadError)
        }

        const entries = getDirectoryNames(response.stdout)
          .sort((left, right) => left.localeCompare(right))
          .map(name => ({
            name,
            path: joinDirectoryPath(normalizedPath, name),
          }))

        setCurrentPath(normalizedPath)
        setDirectories(entries)
      } catch (err) {
        setDirectories([])
        setError(err instanceof Error ? err.message : directoryLoadError)
      } finally {
        setIsLoading(false)
      }
    },
    [deviceId, directoryLoadError]
  )

  const initializeDirectory = useCallback(async () => {
    if (!deviceId) return

    const normalizedInitialPath = initialPath ? normalizeDirectoryPath(initialPath) : ''
    if (normalizedInitialPath) {
      setSelectedPath(normalizedInitialPath)
      await loadDirectories(normalizedInitialPath)
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      const response = await deviceApis.executeCommand(deviceId, {
        command_key: 'pwd',
        timeout_seconds: 10,
        max_output_bytes: 4096,
      })

      if (!response.success) {
        throw new Error(response.error || response.stderr || directoryLoadError)
      }

      const rootPath = normalizeDirectoryPath(getStdoutText(response.stdout))
      setSelectedPath(rootPath)
      await loadDirectories(rootPath)
    } catch (err) {
      setDirectories([])
      setError(err instanceof Error ? err.message : directoryLoadError)
    } finally {
      setIsLoading(false)
    }
  }, [deviceId, directoryLoadError, initialPath, loadDirectories])

  useEffect(() => {
    if (!open) return

    setCurrentPath('')
    setSelectedPath('')
    setDirectories([])
    setError(null)
    void initializeDirectory()
  }, [initializeDirectory, open])

  const handleOpenDirectory = (path: string) => {
    setSelectedPath(path)
    void loadDirectories(path)
  }

  const handleConfirm = () => {
    if (!selectedPath) return
    onConfirm(selectedPath)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]" data-testid="workspace-directory-picker-dialog">
        <DialogHeader>
          <DialogTitle>{t('workspace.directoryPicker.title')}</DialogTitle>
          <DialogDescription>{t('workspace.directoryPicker.description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex min-h-10 items-center gap-2 rounded-md border border-border bg-surface px-3 text-sm">
            <Folder className="h-4 w-4 flex-none text-text-muted" />
            <span className="min-w-0 flex-1 truncate text-text-secondary">
              {currentPath || t('workspace.directoryPicker.loading')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => currentPath && loadDirectories(currentPath)}
              disabled={isLoading || !currentPath}
              data-testid="workspace-directory-refresh-button"
              title={t('workspace.directoryPicker.refresh')}
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          <div className="h-[280px] overflow-auto rounded-md border border-border">
            {isLoading && directories.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-text-muted">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('workspace.directoryPicker.loading')}
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-sm text-destructive">{error}</p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={initializeDirectory}
                  data-testid="workspace-directory-retry-button"
                >
                  {t('workspace.directoryPicker.retry')}
                </Button>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {parentPath && (
                  <button
                    type="button"
                    className="flex h-11 w-full items-center gap-2 px-3 text-left text-sm text-text-secondary hover:bg-surface"
                    onClick={() => handleOpenDirectory(parentPath)}
                    data-testid="workspace-directory-parent-row"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span className="truncate">{t('workspace.directoryPicker.parent')}</span>
                  </button>
                )}

                {directories.map(directory => {
                  const isSelected = selectedPath === directory.path
                  return (
                    <button
                      key={directory.path}
                      type="button"
                      className={`flex h-11 w-full items-center gap-2 px-3 text-left text-sm transition-colors ${
                        isSelected
                          ? 'bg-primary/10 text-primary'
                          : 'text-text-primary hover:bg-surface'
                      }`}
                      onClick={() => setSelectedPath(directory.path)}
                      onDoubleClick={() => handleOpenDirectory(directory.path)}
                      data-testid="workspace-directory-row"
                    >
                      <Folder className="h-4 w-4 flex-none text-text-muted" />
                      <span className="min-w-0 flex-1 truncate">{directory.name}</span>
                      {isSelected && <Check className="h-4 w-4 flex-none" />}
                    </button>
                  )
                })}

                {!isLoading && directories.length === 0 && !parentPath && (
                  <p className="px-3 py-8 text-center text-sm text-text-muted">
                    {t('workspace.directoryPicker.empty')}
                  </p>
                )}
              </div>
            )}
          </div>

          <div
            className="min-h-5 text-xs text-text-secondary"
            data-testid="workspace-directory-selected-path"
          >
            {selectedPath
              ? t('workspace.directoryPicker.selected', { path: selectedPath })
              : t('workspace.directoryPicker.selectHint')}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t('create.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleConfirm}
            disabled={!selectedPath || isLoading}
            data-testid="workspace-directory-confirm-button"
          >
            {t('workspace.directoryPicker.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
