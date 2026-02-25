'use client'

import { useState } from 'react'
import { Info, File, ChevronDown, ChevronUp, Download } from 'lucide-react'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { formatFileSize } from '@/apis/attachments'
import { downloadEvaluationFile } from '@wecode/api/evaluation-shared'
import type { Question, Topic } from '@wecode/types/evaluation'

interface QuestionPanelProps {
  question: Question
  topic: Topic
}

export function QuestionPanel({ question, topic }: QuestionPanelProps) {
  const { theme } = useTheme()
  const { t } = useTranslation('evaluation')
  const [isInstructionsOpen, setIsInstructionsOpen] = useState(true)

  const instructions =
    (question.content_data?.instructions as string)?.trim() ||
    (topic.extra_data?.instructions as string)?.trim()

  const handleDownload = async (key: string, filename: string) => {
    try {
      await downloadEvaluationFile(key, filename)
    } catch (error) {
      console.error('Download failed:', error)
    }
  }

  const attachments = question.content_data?.attachments as
    | Array<{ key: string; filename: string; file_size?: number }>
    | undefined

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-6">
      {/* Instructions */}
      {instructions && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20">
          <CardHeader className="pb-2">
            <button
              onClick={() => setIsInstructionsOpen(!isInstructionsOpen)}
              className="flex w-full items-center justify-between"
            >
              <div className="flex items-center gap-2">
                <Info className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                <span className="text-sm font-medium text-amber-900 dark:text-amber-100">
                  {t('answers.instructions.title')}
                </span>
              </div>
              {isInstructionsOpen ? (
                <ChevronUp className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              ) : (
                <ChevronDown className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              )}
            </button>
          </CardHeader>
          {isInstructionsOpen && (
            <CardContent className="pt-0">
              <div className="rounded-lg border border-amber-200/50 bg-white p-4 dark:border-amber-800/50 dark:bg-black/20">
                <EnhancedMarkdown
                  source={instructions}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                />
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Question Title */}
      <div>
        <h1 className="text-lg font-semibold text-text-primary">{question.title}</h1>
        <div className="mt-2 flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">
            v{question.current_version || '-'}
          </Badge>
        </div>
      </div>

      {/* Question Content */}
      <Card className="flex-1">
        <CardContent className="p-4">
          {typeof question.content_data?.text === 'string' && question.content_data.text ? (
            <EnhancedMarkdown
              source={question.content_data.text}
              theme={theme === 'dark' ? 'dark' : 'light'}
            />
          ) : (
            <p className="py-8 text-center text-text-muted">{t('questions.no_content')}</p>
          )}

          {/* Question Attachments */}
          {attachments && attachments.length > 0 && (
            <div className="mt-6 border-t border-border pt-4">
              <h3 className="mb-3 text-sm font-medium text-text-secondary">
                {t('questions.content_attachments')}
              </h3>
              <div className="space-y-2">
                {attachments.map((attachment, index) => (
                  <div
                    key={attachment.key || index}
                    className="flex items-center gap-3 rounded-lg border border-border bg-surface/50 px-3 py-2"
                  >
                    <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-primary/10">
                      <File className="h-4 w-4 text-primary" />
                    </div>
                    <span className="min-w-0 flex-1 truncate text-sm">{attachment.filename}</span>
                    {attachment.file_size && (
                      <span className="flex-shrink-0 text-xs text-text-muted">
                        {formatFileSize(attachment.file_size)}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 flex-shrink-0"
                      onClick={() => handleDownload(attachment.key, attachment.filename)}
                    >
                      <Download className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
