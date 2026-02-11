// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import '@wecode/i18n' // side-effect import to load wecode translations
import { useState, useMemo, useCallback, useEffect } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Terminal,
  Copy,
  Check,
  ExternalLink,
  AlertTriangle,
  Puzzle,
  Cloud,
  Monitor,
  Plus,
  Loader2,
  KeyIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { apiKeyApis, ApiKey, ApiKeyCreated } from '@/apis/api-keys'
import { AddCloudDeviceButton } from '@wecode/components/cloud-device'

// Install command from environment variable (wecode-specific config)
const INSTALL_COMMAND_UNIX = process.env.NEXT_PUBLIC_DEVICE_INSTALL_COMMAND || ''
const INSTALL_SCRIPT_WINDOWS = process.env.NEXT_PUBLIC_DEVICE_INSTALL_SCRIPT_WINDOWS || ''
const EXECUTOR_DOWNLOAD_TOKEN = process.env.NEXT_PUBLIC_EXECUTOR_DOWNLOAD_TOKEN || ''

type DeviceType = 'local' | 'cloud'
type OsType = 'macos' | 'linux' | 'windows'

export interface LocalExecutorGuideProps {
  backendUrl: string
  authToken: string
  guideUrl?: string
  onCloudDeviceCreated?: () => void
}

// Component for copy button with state
function CopyButton({
  text,
  className,
  onCopySuccess,
}: {
  text: string
  className?: string
  onCopySuccess?: () => void
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      onCopySuccess?.()
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Failed to copy')
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className={cn(
        'shrink-0 text-gray-400 hover:text-white hover:bg-gray-800 h-8 px-3',
        className
      )}
    >
      {copied ? <Check className="w-4 h-4 text-green-400" /> : <Copy className="w-4 h-4" />}
    </Button>
  )
}

// Component for displaying a command step
function CommandStep({
  stepNumber,
  title,
  description,
  command,
  isWindows = false,
}: {
  stepNumber: number
  title: string
  description: string
  command: string
  isWindows?: boolean
}) {
  const stepCircles = ['①', '②', '③', '④', '⑤']
  const prompt = isWindows ? '>' : '$'

  return (
    <div className="mb-6">
      <div className="flex items-start gap-3 mb-3">
        <span className="text-xl text-primary font-medium">{stepCircles[stepNumber - 1]}</span>
        <div>
          <h4 className="font-medium text-text-primary">{title}</h4>
          <p className="text-sm text-text-muted">{description}</p>
        </div>
      </div>
      <div className="bg-gray-900 rounded-lg px-5 py-4 ml-8">
        <div className="flex items-start gap-3">
          <span className="text-gray-500 select-none pt-0.5">{prompt}</span>
          <div className="flex-1 overflow-x-auto">
            <code className="text-sm font-mono whitespace-pre text-green-400">{command}</code>
          </div>
          <CopyButton text={command} />
        </div>
      </div>
    </div>
  )
}

// Device type tab selector
function DeviceTypeSelector({
  selected,
  onSelect,
}: {
  selected: DeviceType
  onSelect: (type: DeviceType) => void
}) {
  const { t } = useTranslation('devices')

  const tabs = [
    { id: 'local' as DeviceType, label: t('device_type_local'), icon: Monitor },
    { id: 'cloud' as DeviceType, label: t('device_type_cloud'), icon: Cloud },
  ]

  return (
    <div className="flex gap-2 mb-6 p-1 bg-gray-100 rounded-lg">
      {tabs.map(tab => {
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            onClick={() => onSelect(tab.id)}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-md text-sm font-medium transition-all',
              selected === tab.id
                ? 'bg-white text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-secondary'
            )}
          >
            <Icon className="w-4 h-4" />
            <span>{tab.label}</span>
          </button>
        )
      })}
    </div>
  )
}

// OS Tab selector component
function OsTabSelector({
  selectedOs,
  onSelect,
}: {
  selectedOs: OsType
  onSelect: (os: OsType) => void
}) {
  const { t } = useTranslation('devices')

  const osTabs: { id: OsType; label: string; icon: string }[] = [
    { id: 'macos', label: t('system_macos'), icon: '' },
    { id: 'linux', label: t('system_linux'), icon: '🐧' },
    { id: 'windows', label: t('system_windows'), icon: '🪟' },
  ]

  return (
    <div className="flex gap-2 mb-6 p-1 bg-gray-100 rounded-lg">
      {osTabs.map(tab => (
        <button
          key={tab.id}
          onClick={() => onSelect(tab.id)}
          className={cn(
            'flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all',
            selectedOs === tab.id
              ? 'bg-white text-text-primary shadow-sm'
              : 'text-text-muted hover:text-text-secondary'
          )}
        >
          <span>{tab.icon}</span>
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * Local Executor Guide - Combined local and cloud device setup
 * Local: Shows 2 steps for all OS (Install + Start with --auth)
 * Cloud: One-click cloud device creation
 */
export function LocalExecutorGuide({ guideUrl, onCloudDeviceCreated }: LocalExecutorGuideProps) {
  const { t } = useTranslation('devices')
  const [deviceType, setDeviceType] = useState<DeviceType>('local')
  const [selectedOs, setSelectedOs] = useState<OsType>('macos')

  const isWindows = selectedOs === 'windows'

  // API Key state (for all OS)
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null)
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<ApiKeyCreated | null>(null)

  // Create API Key dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // Fetch API keys on mount (for all OS)
  const fetchApiKeys = useCallback(async () => {
    setLoadingKeys(true)
    try {
      const response = await apiKeyApis.getApiKeys()
      setApiKeys(response.items || [])
    } catch (error) {
      console.error('Failed to fetch API keys:', error)
      toast.error(t('apikey_load_failed'))
    } finally {
      setLoadingKeys(false)
    }
  }, [t])

  useEffect(() => {
    if (deviceType === 'local') {
      fetchApiKeys()
    }
  }, [deviceType, fetchApiKeys])

  // Handle creating a new API Key
  const handleCreateKey = async () => {
    if (!keyName.trim()) {
      toast.error(t('apikey_name_required'))
      return
    }

    setIsCreating(true)
    try {
      const created = await apiKeyApis.createApiKey({ name: keyName.trim() })
      setCreateDialogOpen(false)
      setKeyName('')
      toast.success(t('apikey_create_success'))
      setSelectedKeyId(created.id)
      setNewlyCreatedKey(created)
      fetchApiKeys()
    } catch (error) {
      toast.error(t('apikey_create_failed'))
      console.error('Failed to create API key:', error)
    } finally {
      setIsCreating(false)
    }
  }

  // Get the auth token value for commands
  const authTokenValue = useMemo(() => {
    if (newlyCreatedKey && newlyCreatedKey.id === selectedKeyId) return newlyCreatedKey.key
    return '<YOUR_API_KEY>'
  }, [newlyCreatedKey, selectedKeyId])

  const hasRealApiKey = newlyCreatedKey && newlyCreatedKey.id === selectedKeyId

  // Active API keys only
  const activeApiKeys = apiKeys.filter(key => key.is_active)

  // Windows commands - download to Desktop for easy access
  const windowsDownloadCommand = useMemo(() => {
    return `Invoke-WebRequest -Uri "${INSTALL_SCRIPT_WINDOWS}" -Headers @{"PRIVATE-TOKEN"="${EXECUTOR_DOWNLOAD_TOKEN}"} -OutFile "$env:USERPROFILE\\Desktop\\install-wecode.ps1"`
  }, [])

  const windowsExecuteCommand = useMemo(() => {
    return `& "$env:USERPROFILE\\Desktop\\install-wecode.ps1" -AuthToken "${authTokenValue}"`
  }, [authTokenValue])

  // Unix commands - 2 steps: install + start with auth
  const executorStartCommand = useMemo(() => {
    return `wecode executor start --auth ${authTokenValue}`
  }, [authTokenValue])

  return (
    <div className="flex flex-col items-center justify-center py-8">
      {/* Main card */}
      <div className="w-full max-w-2xl bg-surface border border-border rounded-xl p-6 shadow-sm">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
            <Terminal className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-text-primary">{t('device_setup_title')}</h3>
            <p className="text-sm text-text-muted">{t('device_setup_description')}</p>
          </div>
        </div>

        {/* Device Type Selector */}
        <DeviceTypeSelector selected={deviceType} onSelect={setDeviceType} />

        {/* Local Device Content */}
        {deviceType === 'local' && (
          <>
            {/* OS Tab Selector */}
            <OsTabSelector selectedOs={selectedOs} onSelect={setSelectedOs} />

            {/* macOS / Linux Steps */}
            {!isWindows && (
              <>
                {/* API Key Selection */}
                <div className="mb-6 p-4 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <KeyIcon className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-text-primary">
                        {t('select_apikey')}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCreateDialogOpen(true)}
                      className="flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      {t('create_apikey')}
                    </Button>
                  </div>

                  {loadingKeys ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
                    </div>
                  ) : activeApiKeys.length === 0 ? (
                    <p className="text-sm text-text-muted text-center py-4">{t('no_apikeys')}</p>
                  ) : (
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {activeApiKeys.map(apiKey => (
                        <div
                          key={apiKey.id}
                          className={cn(
                            'flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors',
                            selectedKeyId === apiKey.id
                              ? 'bg-primary/10 border border-primary'
                              : 'hover:bg-hover border border-transparent'
                          )}
                          onClick={() => {
                            setSelectedKeyId(apiKey.id)
                            if (newlyCreatedKey && newlyCreatedKey.id !== apiKey.id) {
                              setNewlyCreatedKey(null)
                            }
                          }}
                        >
                          <div
                            className={cn(
                              'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                              selectedKeyId === apiKey.id
                                ? 'border-primary bg-primary'
                                : 'border-border'
                            )}
                          >
                            {selectedKeyId === apiKey.id && (
                              <Check className="w-2.5 h-2.5 text-white" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-text-primary truncate block">
                              {apiKey.name}
                            </span>
                            <code className="text-xs text-text-muted">{apiKey.key_prefix}</code>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Warning for existing key selection */}
                  {selectedKeyId && !hasRealApiKey && (
                    <div className="flex items-start gap-2 p-2 mt-3 bg-amber-50 border border-amber-200 rounded-md">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700">{t('apikey_existing_warning')}</p>
                    </div>
                  )}
                </div>

                {/* Step 1: Install wecode-cli */}
                <CommandStep
                  stepNumber={1}
                  title={t('internal_step_install')}
                  description={t('internal_step_install_desc')}
                  command={INSTALL_COMMAND_UNIX}
                />

                {/* Step 2: Start with auth */}
                <CommandStep
                  stepNumber={2}
                  title={t('internal_step_start')}
                  description={t('internal_step_start_desc')}
                  command={executorStartCommand}
                />
              </>
            )}

            {/* Windows Steps */}
            {isWindows && (
              <>
                {/* API Key Selection */}
                <div className="mb-6 p-4 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <KeyIcon className="w-4 h-4 text-primary" />
                      <span className="text-sm font-medium text-text-primary">
                        {t('select_apikey')}
                      </span>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setCreateDialogOpen(true)}
                      className="flex items-center gap-1"
                    >
                      <Plus className="w-3 h-3" />
                      {t('create_apikey')}
                    </Button>
                  </div>

                  {loadingKeys ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="w-5 h-5 animate-spin text-text-muted" />
                    </div>
                  ) : activeApiKeys.length === 0 ? (
                    <p className="text-sm text-text-muted text-center py-4">{t('no_apikeys')}</p>
                  ) : (
                    <div className="space-y-2 max-h-[200px] overflow-y-auto">
                      {activeApiKeys.map(apiKey => (
                        <div
                          key={apiKey.id}
                          className={cn(
                            'flex items-center gap-3 p-2 rounded-md cursor-pointer transition-colors',
                            selectedKeyId === apiKey.id
                              ? 'bg-primary/10 border border-primary'
                              : 'hover:bg-hover border border-transparent'
                          )}
                          onClick={() => {
                            setSelectedKeyId(apiKey.id)
                            if (newlyCreatedKey && newlyCreatedKey.id !== apiKey.id) {
                              setNewlyCreatedKey(null)
                            }
                          }}
                        >
                          <div
                            className={cn(
                              'w-4 h-4 rounded-full border-2 flex items-center justify-center flex-shrink-0',
                              selectedKeyId === apiKey.id
                                ? 'border-primary bg-primary'
                                : 'border-border'
                            )}
                          >
                            {selectedKeyId === apiKey.id && (
                              <Check className="w-2.5 h-2.5 text-white" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-medium text-text-primary truncate block">
                              {apiKey.name}
                            </span>
                            <code className="text-xs text-text-muted">{apiKey.key_prefix}</code>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Warning for existing key selection */}
                  {selectedKeyId && !hasRealApiKey && (
                    <div className="flex items-start gap-2 p-2 mt-3 bg-amber-50 border border-amber-200 rounded-md">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700">{t('apikey_existing_warning')}</p>
                    </div>
                  )}
                </div>

                {/* Step 1: Download script */}
                <CommandStep
                  stepNumber={1}
                  title={t('windows_step_download')}
                  description={t('windows_step_download_desc')}
                  command={windowsDownloadCommand}
                  isWindows={true}
                />

                {/* Step 2: Execute script */}
                <CommandStep
                  stepNumber={2}
                  title={t('windows_step_execute')}
                  description={t('windows_step_execute_desc')}
                  command={windowsExecuteCommand}
                  isWindows={true}
                />
              </>
            )}

            {/* Plugins section - only show for macOS/Linux */}
            {!isWindows && (
              <div className="border-t border-border pt-5 mt-2 mb-6">
                <div className="flex items-center gap-2 mb-3">
                  <Puzzle className="w-4 h-4 text-primary" />
                  <h4 className="font-medium text-text-primary">{t('plugins_title')}</h4>
                </div>
                <p className="text-sm text-text-muted mb-4 ml-6">{t('plugins_description')}</p>

                {/* Browser plugin */}
                <div className="bg-gray-50 border border-gray-200 rounded-lg p-4 ml-6">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <span className="font-medium text-text-primary">
                        {t('plugin_browser_name')}
                      </span>
                      <p className="text-xs text-text-muted mt-1">
                        {t('plugin_browser_description')}
                      </p>
                    </div>
                  </div>
                  <div className="bg-gray-900 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-3">
                      <span className="text-gray-500 select-none">$</span>
                      <code className="flex-1 text-sm font-mono text-green-400">
                        wecode executor install browser
                      </code>
                      <CopyButton text="wecode executor install browser" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Security hints */}
            <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-3">
              <span className="text-blue-600 shrink-0">💡</span>
              <p className="text-sm text-blue-700">
                {isWindows ? t('windows_security_hint') : t('gatekeeper_hint')}
              </p>
            </div>

            {/* Beta warning */}
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-sm text-amber-700">{t('beta_warning')}</p>
            </div>
          </>
        )}

        {/* Cloud Device Content */}
        {deviceType === 'cloud' && (
          <div className="py-6">
            {/* Cloud device description */}
            <div className="text-center mb-6">
              <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                <Cloud className="w-8 h-8 text-primary" />
              </div>
              <h4 className="text-lg font-medium text-text-primary mb-2">{t('cloud_device')}</h4>
              <p className="text-sm text-text-muted">{t('cloud_device_description')}</p>
            </div>

            {/* Add Cloud Device button */}
            <div className="flex justify-center mb-6">
              <AddCloudDeviceButton onSuccess={onCloudDeviceCreated} />
            </div>

            {/* Cloud device hints */}
            <div className="space-y-3">
              <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
                <span className="text-blue-600 shrink-0">💡</span>
                <p className="text-sm text-blue-700">{t('cloud_device_auto_config')}</p>
              </div>
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-sm text-amber-700">{t('cloud_device_limit_warning')}</p>
              </div>
            </div>
          </div>
        )}

        {/* Guide link */}
        {guideUrl && (
          <div className="mt-4 flex justify-center">
            <a
              href={guideUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            >
              <ExternalLink className="w-4 h-4" />
              {t('view_config')}
            </a>
          </div>
        )}
      </div>

      {/* Create API Key Dialog */}
      <Dialog
        open={createDialogOpen}
        onOpenChange={open => {
          setCreateDialogOpen(open)
          if (!open) {
            setKeyName('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('create_apikey_title')}</DialogTitle>
            <DialogDescription>{t('create_apikey_desc')}</DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="text-sm font-medium text-text-primary">{t('apikey_name')}</label>
            <Input
              className="mt-2"
              placeholder={t('apikey_name_placeholder')}
              value={keyName}
              onChange={e => setKeyName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !isCreating && handleCreateKey()}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDialogOpen(false)}
              disabled={isCreating}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleCreateKey}
              disabled={isCreating || !keyName.trim()}
            >
              {isCreating ? (
                <div className="flex items-center">
                  <Loader2 className="w-4 h-4 animate-spin mr-2" />
                  {t('creating')}
                </div>
              ) : (
                t('create')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
