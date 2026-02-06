// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { Terminal, Copy, Check, ExternalLink, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'

// Install script URLs from GitHub
const INSTALL_SCRIPT_URL_UNIX =
  'https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.sh'
const INSTALL_SCRIPT_URL_WINDOWS =
  'https://github.com/wecode-ai/Wegent/releases/latest/download/local_executor_install.ps1'

type OsType = 'macos' | 'linux' | 'windows'

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
 * External network version of Local Executor Guide
 * Shows 2 steps: Install from GitHub -> Run with environment variables
 * Supports macOS, Linux, and Windows
 */
export function LocalExecutorGuide({ backendUrl, authToken, guideUrl }: LocalExecutorGuideProps) {
  const { t } = useTranslation('devices')
  const [selectedOs, setSelectedOs] = useState<OsType>('macos')

  const isWindows = selectedOs === 'windows'

  // Step 1: Install from GitHub (different for Unix vs Windows)
  const installCommand = useMemo(() => {
    if (isWindows) {
      return `irm ${INSTALL_SCRIPT_URL_WINDOWS} | iex`
    }
    return `curl -fsSL ${INSTALL_SCRIPT_URL_UNIX} | bash`
  }, [isWindows])

  // Step 2: Run with environment variables (different for Unix vs Windows)
  const runCommand = useMemo(() => {
    if (isWindows) {
      return `$env:EXECUTOR_MODE="local"\n$env:WEGENT_BACKEND_URL="${backendUrl}"\n$env:WEGENT_AUTH_TOKEN="${authToken}"\n& "$env:USERPROFILE\\.wegent-executor\\bin\\wegent-executor.exe"`
    }
    return `EXECUTOR_MODE=local \\\nWEGENT_BACKEND_URL=${backendUrl} \\\nWEGENT_AUTH_TOKEN=${authToken} \\\n~/.wegent-executor/bin/wegent-executor`
  }, [backendUrl, authToken, isWindows])

  // Get description text based on OS
  const getDescription = () => {
    if (isWindows) {
      return t('local_executor_description_windows')
    }
    if (selectedOs === 'linux') {
      return t('local_executor_description_linux')
    }
    return t('local_executor_description')
  }

  // Get install step description based on OS
  const getInstallDesc = () => {
    if (isWindows) {
      return t('step_install_desc_windows')
    }
    return t('step_install_desc')
  }

  // Get security hint based on OS
  const getSecurityHint = () => {
    if (isWindows) {
      return t('windows_security_hint')
    }
    return t('gatekeeper_hint')
  }

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
            <p className="text-sm text-text-muted">{getDescription()}</p>
          </div>
        </div>

        {/* OS Tab Selector */}
        <OsTabSelector selectedOs={selectedOs} onSelect={setSelectedOs} />

        {/* Step 1: Install */}
        <CommandStep
          stepNumber={1}
          title={t('step_install')}
          description={getInstallDesc()}
          command={installCommand}
          isWindows={isWindows}
        />

        {/* Step 2: Run */}
        <CommandStep
          stepNumber={2}
          title={t('step_run')}
          description={t('step_run_desc')}
          command={runCommand}
          isWindows={isWindows}
        />

        {/* Security warning */}
        <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg mb-4">
          <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">{t('security_warning')}</p>
        </div>

        {/* Platform-specific security hint */}
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg mb-3">
          <span className="text-blue-600 shrink-0">💡</span>
          <p className="text-sm text-blue-700">{getSecurityHint()}</p>
        </div>

        {/* Token expiry hint */}
        <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <span className="text-blue-600 shrink-0">🔄</span>
          <p className="text-sm text-blue-700">{t('token_expiry_hint')}</p>
        </div>

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
    </div>
  )
}
