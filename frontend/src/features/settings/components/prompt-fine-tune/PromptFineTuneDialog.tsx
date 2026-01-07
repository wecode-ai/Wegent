// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/hooks/useTranslation'
import { Wand2 } from 'lucide-react'
import { wizardApis } from '@/apis/wizard'
import PromptTestPanel from './PromptTestPanel'
import PromptComparePanel from './PromptComparePanel'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

interface PromptFineTuneDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPrompt: string
  onSave: (newPrompt: string) => void
  modelName?: string
}

export default function PromptFineTuneDialog({
  open,
  onOpenChange,
  initialPrompt,
  onSave,
  modelName,
}: PromptFineTuneDialogProps) {
  const { t } = useTranslation('promptTune')
  const isMobile = useIsMobile()

  // State
  const [currentPrompt, setCurrentPrompt] = useState(initialPrompt)
  const [originalPrompt, setOriginalPrompt] = useState(initialPrompt)
  const [testMessage, setTestMessage] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [isTestingPrompt, setIsTestingPrompt] = useState(false)
  const [isIteratingPrompt, setIsIteratingPrompt] = useState(false)
  const [userFeedback, setUserFeedback] = useState('')
  const [selectedModel, setSelectedModel] = useState(modelName || '')
  const [lastTestMessage, setLastTestMessage] = useState('')

  // Reset state when dialog opens
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (newOpen) {
        setCurrentPrompt(initialPrompt)
        setOriginalPrompt(initialPrompt)
        setTestMessage('')
        setAiResponse('')
        setUserFeedback('')
        setLastTestMessage('')
      }
      onOpenChange(newOpen)
    },
    [initialPrompt, onOpenChange]
  )

  // Test prompt with streaming
  const handleTestPrompt = useCallback(async () => {
    if (!testMessage.trim() || !selectedModel) return

    setIsTestingPrompt(true)
    setAiResponse('')
    setLastTestMessage(testMessage)

    try {
      let fullResponse = ''
      const generator = wizardApis.testPromptStream(
        currentPrompt,
        testMessage,
        selectedModel,
        chunk => {
          fullResponse += chunk
          setAiResponse(fullResponse)
        }
      )

      // Consume the generator
      for await (const _ of generator) {
        // Chunks are handled by onChunk callback
      }

      // Clear test message input after successful test
      setTestMessage('')
    } catch (error) {
      console.error('Failed to test prompt:', error)
      setAiResponse(t('common:errors.request_failed'))
    } finally {
      setIsTestingPrompt(false)
    }
  }, [testMessage, selectedModel, currentPrompt, t])

  // Iterate prompt based on feedback
  const handleIteratePrompt = useCallback(async () => {
    if (!userFeedback.trim()) return

    setIsIteratingPrompt(true)

    try {
      const response = await wizardApis.iteratePrompt(
        currentPrompt,
        lastTestMessage,
        aiResponse,
        userFeedback,
        selectedModel
      )

      setCurrentPrompt(response.improved_prompt)
      setUserFeedback('')
      // Clear conversation to test new prompt
      setAiResponse('')
      setTestMessage(lastTestMessage) // Pre-fill with last test message for convenience
    } catch (error) {
      console.error('Failed to iterate prompt:', error)
      setAiResponse(t('common:errors.request_failed'))
    } finally {
      setIsIteratingPrompt(false)
    }
  }, [userFeedback, currentPrompt, lastTestMessage, aiResponse, selectedModel, t])

  // Reset to original prompt
  const handleReset = useCallback(() => {
    setCurrentPrompt(originalPrompt)
    setAiResponse('')
    setUserFeedback('')
  }, [originalPrompt])

  // Save and close
  const handleSave = useCallback(() => {
    onSave(currentPrompt)
    onOpenChange(false)
  }, [currentPrompt, onSave, onOpenChange])

  // Check if prompt has been modified
  const isModified = currentPrompt !== originalPrompt

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={`${isMobile ? 'max-w-[95vw] h-[90vh]' : 'max-w-[900px] h-[700px]'} flex flex-col p-0 gap-0`}
      >
        <DialogHeader className="px-4 py-3 border-b border-border flex-shrink-0">
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Wand2 className="w-5 h-5 text-primary" />
            {t('dialog.title')}
          </DialogTitle>
          <DialogDescription className="text-sm text-text-muted">
            {t('dialog.description')}
          </DialogDescription>
        </DialogHeader>

        {/* Main content area */}
        <div className={`flex-1 min-h-0 flex ${isMobile ? 'flex-col' : 'flex-row'}`}>
          {/* Left panel - Test area */}
          <div className={`${isMobile ? 'h-1/2' : 'w-1/2'} border-r border-border overflow-hidden`}>
            <PromptTestPanel
              systemPrompt={currentPrompt}
              testMessage={testMessage}
              setTestMessage={setTestMessage}
              aiResponse={aiResponse}
              isTestingPrompt={isTestingPrompt}
              isIteratingPrompt={isIteratingPrompt}
              userFeedback={userFeedback}
              setUserFeedback={setUserFeedback}
              selectedModel={selectedModel}
              onModelChange={setSelectedModel}
              onTestPrompt={handleTestPrompt}
              onIteratePrompt={handleIteratePrompt}
              hideIterateSection={true}
            />
          </div>

          {/* Right panel - Prompt compare area */}
          <div className={`${isMobile ? 'h-1/2 border-t' : 'w-1/2'} border-border overflow-hidden`}>
            <PromptComparePanel
              originalPrompt={originalPrompt}
              currentPrompt={currentPrompt}
              onPromptChange={setCurrentPrompt}
              onReset={handleReset}
              userFeedback={userFeedback}
              setUserFeedback={setUserFeedback}
              isIteratingPrompt={isIteratingPrompt}
              onIteratePrompt={handleIteratePrompt}
              hasAiResponse={!!aiResponse}
            />
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-4 py-3 border-t border-border flex-shrink-0">
          <div className="flex items-center justify-between w-full">
            <div className="text-xs text-text-muted">
              {isModified ? t('dialog.unsaved_changes') : ''}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('actions.cancel')}
              </Button>
              <Button variant="primary" onClick={handleSave}>
                {t('actions.save')}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
