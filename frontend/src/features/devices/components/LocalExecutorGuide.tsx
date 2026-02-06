// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState, useCallback, useEffect } from 'react'
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
  KeyIcon,
  Plus,
  Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { apiKeyApis, ApiKey, ApiKeyCreated } from '@/apis/api-keys'

// Install script URL from GitHub
const INSTALL_SCRIPT_URL =
  'https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh'

export interface LocalExecutorGuideProps {
  backendUrl: string
  authToken: string
  guideUrl?: string
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
}: {
  stepNumber: number
  title: string
  description: string
  command: string
}) {
  const stepCircles = ['①', '②', '③', '④', '⑤']

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
          <span className="text-gray-500 select-none pt-0.5">$</span>
          <div className="flex-1 overflow-x-auto">
            <code className="text-sm font-mono whitespace-pre text-green-400">{command}</code>
          </div>
          <CopyButton text={command} />
        </div>
      </div>
    </div>
  )
}

// Auth mode type
type AuthMode = 'token' | 'apikey'

/**
 * Local Executor Guide with API Key support
 * Shows 2 steps: Install from GitHub -> Run with authentication
 * Supports both JWT token and API Key authentication methods
 */
export function LocalExecutorGuide({ backendUrl, authToken, guideUrl }: LocalExecutorGuideProps) {
  const { t } = useTranslation('devices')

  // Auth mode state
  const [authMode, setAuthMode] = useState<AuthMode>('token')

  // API Key state
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([])
  const [loadingKeys, setLoadingKeys] = useState(false)
  const [selectedKeyId, setSelectedKeyId] = useState<number | null>(null)
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<ApiKeyCreated | null>(null)

  // Create API Key dialog state
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [keyName, setKeyName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  // Fetch API keys when switching to API Key mode
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
    if (authMode === 'apikey') {
      fetchApiKeys()
    }
  }, [authMode, fetchApiKeys])

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
      // Auto-select the newly created key
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

  // Get the auth token value for the command
  const getAuthTokenValue = () => {
    if (authMode === 'token') {
      return authToken
    }
    // API Key mode
    if (newlyCreatedKey && newlyCreatedKey.id === selectedKeyId) {
      return newlyCreatedKey.key
    }
    return '<YOUR_API_KEY>'
  }

  const authTokenValue = getAuthTokenValue()
  const hasRealApiKey =
    authMode === 'apikey' && newlyCreatedKey && newlyCreatedKey.id === selectedKeyId

  // Step 1: Install from GitHub
  const installCommand = useMemo(() => `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`, [])

  // Step 2: Run with environment variables
  const runCommand = useMemo(
    () =>
      `EXECUTOR_MODE=local \\\nWEGENT_BACKEND_URL=${backendUrl} \\\nWEGENT_AUTH_TOKEN=${authTokenValue} \\\n~/.wegent-executor/bin/wegent-executor`,
    [backendUrl, authTokenValue]
  )

  // Active API keys only
  const activeApiKeys = apiKeys.filter(key => key.is_active)

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
            <h3 className="text-lg font-semibold text-text-primary">{t('local_executor_title')}</h3>
            <p className="text-sm text-text-muted">{t('local_executor_description')}</p>
          </div>
        </div>

        {/* Step 1: Install */}
        <CommandStep
          stepNumber={1}
          title={t('step_install')}
          description={t('step_install_desc')}
          command={installCommand}
        />

        {/* Step 2: Auth Mode Selector and Run Command */}
        <div className="mb-6">
          <div className="flex items-start gap-3 mb-3">
            <span className="text-xl text-primary font-medium">②</span>
            <div className="flex-1">
              <h4 className="font-medium text-text-primary">{t('step_run')}</h4>
              <p className="text-sm text-text-muted">{t('step_run_desc')}</p>

              {/* Auth mode tabs */}
              <div className="flex gap-2 mt-3 mb-4">
                <Button
                  variant={authMode === 'token' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setAuthMode('token')}
                  className="flex items-center gap-2"
                >
                  <KeyIcon className="w-4 h-4" />
                  {t('auth_mode_token')}
                </Button>
                <Button
                  variant={authMode === 'apikey' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setAuthMode('apikey')}
                  className="flex items-center gap-2"
                >
                  <KeyIcon className="w-4 h-4" />
                  {t('auth_mode_apikey')}
                </Button>
              </div>

              {/* API Key Selection (when in apikey mode) */}
              {authMode === 'apikey' && (
                <div className="mb-4 p-4 bg-muted rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium text-text-primary">
                      {t('select_apikey')}
                    </span>
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
                            // Clear newly created key if selecting a different key
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
                  {authMode === 'apikey' && selectedKeyId && !hasRealApiKey && (
                    <div className="flex items-start gap-2 p-2 mt-3 bg-amber-50 border border-amber-200 rounded-md">
                      <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <p className="text-xs text-amber-700">{t('apikey_existing_warning')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Command display */}
          <div className="bg-gray-900 rounded-lg px-5 py-4 ml-8">
            <div className="flex items-start gap-3">
              <span className="text-gray-500 select-none pt-0.5">$</span>
              <div className="flex-1 overflow-x-auto">
                <code className="text-sm font-mono whitespace-pre text-green-400">
                  {runCommand}
                </code>
              </div>
              <CopyButton text={runCommand} />
            </div>
          </div>
        </div>

        {/* Security warning */}
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">{t('security_warning')}</p>
        </div>

        {/* Gatekeeper hint */}
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-3">
          <span className="text-blue-600 shrink-0">💡</span>
          <p className="text-sm text-blue-700">{t('gatekeeper_hint')}</p>
        </div>

        {/* Token expiry hint (only for token mode) */}
        {authMode === 'token' && (
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <span className="text-blue-600 shrink-0">🔄</span>
            <p className="text-sm text-blue-700">{t('token_expiry_hint')}</p>
          </div>
        )}

        {/* API Key benefit hint (only for apikey mode) */}
        {authMode === 'apikey' && (
          <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
            <span className="text-blue-600 shrink-0">✨</span>
            <p className="text-sm text-blue-700">{t('apikey_benefit_hint')}</p>
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
              {t('view_guide')}
            </a>
          </div>
        )}
      </div>

      {/* Create API Key Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
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
