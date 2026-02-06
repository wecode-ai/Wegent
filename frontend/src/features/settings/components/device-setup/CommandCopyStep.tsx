// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  ClipboardDocumentIcon,
  CheckIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { ApiKeyCreated } from '@/apis/api-keys'

interface CommandCopyStepProps {
  selectedKeyId: number | null
  newlyCreatedKey: ApiKeyCreated | null
}

export function CommandCopyStep({ selectedKeyId, newlyCreatedKey }: CommandCopyStepProps) {
  const { t } = useTranslation()
  const { toast } = useToast()

  const [copiedCommand, setCopiedCommand] = useState<'method1' | 'method2' | null>(null)

  // Get the API key value to display
  const getApiKeyValue = () => {
    // If we have a newly created key and it's the selected one, show the full key
    if (newlyCreatedKey && newlyCreatedKey.id === selectedKeyId) {
      return newlyCreatedKey.key
    }
    // Otherwise show placeholder
    return 'YOUR_API_KEY'
  }

  const apiKeyValue = getApiKeyValue()
  const hasRealKey = newlyCreatedKey && newlyCreatedKey.id === selectedKeyId

  // Generate commands
  const command1 = `wegent-executor --mode local --token ${apiKeyValue}`
  const command2 = `export WEGENT_TOKEN=${apiKeyValue}\nwegent-executor --mode local`

  const handleCopyCommand = async (command: string, method: 'method1' | 'method2') => {
    try {
      await navigator.clipboard.writeText(command)
      setCopiedCommand(method)
      toast({
        title: t('common:device_setup.step2.copied'),
      })
      setTimeout(() => setCopiedCommand(null), 2000)
    } catch {
      toast({
        variant: 'destructive',
        title: 'Failed to copy',
      })
    }
  }

  return (
    <div className="space-y-4">
      {/* Description */}
      <p className="text-sm text-text-secondary">{t('common:device_setup.step2.description')}</p>

      {/* Method 1: Direct token parameter */}
      <Card className="p-4">
        <h4 className="text-sm font-medium text-text-primary mb-2">
          {t('common:device_setup.step2.method1_title')}
        </h4>
        <div className="relative">
          <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto">{command1}</pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-7 w-7"
            onClick={() => handleCopyCommand(command1, 'method1')}
            title={t('common:device_setup.step2.copy_command')}
          >
            {copiedCommand === 'method1' ? (
              <CheckIcon className="w-4 h-4 text-success" />
            ) : (
              <ClipboardDocumentIcon className="w-4 h-4" />
            )}
          </Button>
        </div>
      </Card>

      {/* Method 2: Environment variable */}
      <Card className="p-4">
        <h4 className="text-sm font-medium text-text-primary mb-2">
          {t('common:device_setup.step2.method2_title')}
        </h4>
        <div className="relative">
          <pre className="bg-muted p-3 rounded text-xs font-mono overflow-x-auto whitespace-pre-wrap">
            {command2}
          </pre>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-7 w-7"
            onClick={() => handleCopyCommand(command2.replace('\n', ' && '), 'method2')}
            title={t('common:device_setup.step2.copy_command')}
          >
            {copiedCommand === 'method2' ? (
              <CheckIcon className="w-4 h-4 text-success" />
            ) : (
              <ClipboardDocumentIcon className="w-4 h-4" />
            )}
          </Button>
        </div>
      </Card>

      {/* Hint */}
      <div className="flex items-start gap-2 p-3 bg-primary/5 border border-primary/20 rounded-md">
        <InformationCircleIcon className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
        <p className="text-sm text-text-secondary">{t('common:device_setup.step2.hint')}</p>
      </div>

      {/* Warning if using placeholder */}
      {!hasRealKey && (
        <div className="flex items-start gap-2 p-3 bg-warning/10 border border-warning/20 rounded-md">
          <InformationCircleIcon className="w-5 h-5 text-warning flex-shrink-0 mt-0.5" />
          <p className="text-sm text-warning">
            {t('common:device_setup.step1.existing_key_warning')}
          </p>
        </div>
      )}
    </div>
  )
}

export default CommandCopyStep
