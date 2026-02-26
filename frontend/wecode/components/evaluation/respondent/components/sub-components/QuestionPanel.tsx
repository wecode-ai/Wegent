'use client'

import { FileText, HelpCircle, ChevronDown, ChevronUp } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import EnhancedMarkdown from '@/components/common/EnhancedMarkdown'
import { useTheme } from '@/features/theme/ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import type { Question } from '@wecode/types/evaluation'

interface QuestionPanelProps {
  question: Question | null
  instructions: string | undefined
  showInstructions: boolean
  onToggleInstructions: () => void
}

export function QuestionPanel({
  question,
  instructions,
  showInstructions,
  onToggleInstructions,
}: QuestionPanelProps) {
  const { t } = useTranslation('evaluation')
  const { theme } = useTheme()
  const isMobile = useIsMobile()

  const panelContent = (
    <>
      {/* Instructions - Collapsible */}
      {instructions && (
        <Card className={`${isMobile ? 'm-4' : 'mb-6'} border-amber-200 bg-amber-50/50`}>
          <Collapsible open={showInstructions} onOpenChange={onToggleInstructions}>
            <CollapsibleTrigger asChild>
              <button
                className={`w-full flex items-center justify-between text-left hover:bg-amber-50/80 transition-colors ${
                  isMobile ? 'p-3' : 'p-4 rounded-t-lg'
                }`}
              >
                <div className="flex items-center gap-2 text-amber-900">
                  <FileText className="h-4 w-4" />
                  <span className={`font-medium ${isMobile ? 'text-sm' : 'text-sm'}`}>
                    {t('answers.instructions.title')}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-amber-700 ${isMobile ? 'text-sm' : 'text-sm'}`}>
                    {showInstructions ? t('actions.collapse') : t('actions.expand')}
                  </span>
                  {showInstructions ? (
                    <ChevronUp className="h-4 w-4 text-amber-700" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-amber-700" />
                  )}
                </div>
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <CardContent className={`pt-0 ${isMobile ? 'pb-3 px-3' : 'pb-4 px-4'}`}>
                <div className={`rounded-lg bg-white/50 ${isMobile ? 'p-3' : 'p-4'}`}>
                  <div className="prose prose-sm max-w-none text-amber-800">
                    <EnhancedMarkdown
                      source={instructions}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                    />
                  </div>
                </div>
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}

      {/* Question Content */}
      <div className={`prose max-w-none text-text-primary ${isMobile ? 'prose-sm' : 'prose-base'}`}>
        {typeof question?.content_data?.text === 'string' && question.content_data.text ? (
          <EnhancedMarkdown
            source={question.content_data.text}
            theme={theme === 'dark' ? 'dark' : 'light'}
          />
        ) : (
          <p className={`text-text-muted text-center ${isMobile ? 'py-4' : 'py-8'}`}>
            {t('questions.no_content')}
          </p>
        )}
      </div>
    </>
  )

  if (isMobile) {
    return (
      <div className="border-b border-border">
        {/* Mobile: Question Title */}
        {question && (
          <div className="border-b border-border p-4">
            <h1 className="text-lg font-semibold text-text-primary">{question.title}</h1>
          </div>
        )}
        {/* Mobile: Instructions + Content */}
        <div className="p-4">{panelContent}</div>
      </div>
    )
  }

  // Desktop: Two-column left panel
  return (
    <div className="overflow-y-auto bg-white border-r border-border">
      {/* Panel Header */}
      <div className="sticky top-0 z-10 bg-white border-b border-border px-8 py-4 flex items-center gap-2">
        <HelpCircle className="h-5 w-5 text-primary" />
        <span className="font-medium text-text-primary">{t('ui.question_content')}</span>
      </div>

      <div className="max-w-2xl mx-auto p-8">{panelContent}</div>
    </div>
  )
}
