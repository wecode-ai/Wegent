# Unify RespondentQuestion Component Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Merge RespondentQuestionDesktop and RespondentQuestionMobile into a single unified component with shared hooks and sub-components.

**Architecture:** Extract all business logic into `useRespondentQuestion` hook, create 3 presentation sub-components (QuestionHeader, QuestionPanel, AnswerPanel), and a unified main component that conditionally renders mobile/desktop layouts.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, shadcn/ui, Next.js 15 dynamic imports

---

## Pre-Implementation Checklist

- [ ] Read existing components: `RespondentQuestionDesktop.tsx` and `RespondentQuestionMobile.tsx`
- [ ] Understand the differences between mobile and desktop layouts
- [ ] Review `useIsMobile` hook usage in other pages

---

### Task 1: Create Shared Hook - `useRespondentQuestion.ts`

**Files:**
- Create: `frontend/wecode/components/evaluation/respondent/hooks/useRespondentQuestion.ts`

**Step 1: Create the hook file**

```typescript
'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  respondentGetQuestion,
  respondentSubmitAnswer,
  respondentListAnswerHistory,
} from '@wecode/api/evaluation-respondent'
import { ContentType } from '@wecode/types/evaluation'
import type { Question, Topic, EvalAttachment, Answer } from '@wecode/types/evaluation'
import { useQuestionDraft } from './useQuestionDraft'

interface UseRespondentQuestionOptions {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

interface UseRespondentQuestionReturn {
  // Data
  question: Question | null
  loading: boolean
  answerText: string
  attachments: EvalAttachment[]
  lastSubmittedAnswer: Answer | null

  // UI State
  submitting: boolean
  showConfirmDialog: boolean
  showTextInput: boolean
  showLastSubmitted: boolean
  showInstructions: boolean

  // Derived
  progress: number
  instructions: string | undefined
  lastSaved: Date | null
  isEmpty: boolean

  // Actions
  setAnswerText: (text: string) => void
  setAttachments: (attachments: EvalAttachment[]) => void
  setShowTextInput: (show: boolean) => void
  setShowLastSubmitted: (show: boolean) => void
  setShowInstructions: (show: boolean) => void
  setShowConfirmDialog: (show: boolean) => void

  // Handlers
  handlePrevious: () => void
  handleNext: () => void
  handleSubmitClick: () => void
  handleSubmit: () => Promise<void>
}

export function useRespondentQuestion(
  options: UseRespondentQuestionOptions
): UseRespondentQuestionReturn {
  const { topic, questionId, currentQuestionIndex, totalQuestions, questionIds } = options
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [question, setQuestion] = useState<Question | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [showTextInput, setShowTextInput] = useState(false)
  const [showLastSubmitted, setShowLastSubmitted] = useState(false)
  const [showInstructions, setShowInstructions] = useState(true)

  const { draft, lastSaved, saveDraft, clearDraft } = useQuestionDraft(questionId)
  const [answerText, setAnswerText] = useState('')
  const [attachments, setAttachments] = useState<EvalAttachment[]>([])
  const [lastSubmittedAnswer, setLastSubmittedAnswer] = useState<Answer | null>(null)

  // Load draft on mount
  useEffect(() => {
    if (draft) {
      setAnswerText(draft.text)
      setAttachments(draft.attachments)
    }
  }, [draft])

  // Load last submitted answer
  const loadLastSubmittedAnswer = useCallback(async () => {
    try {
      const response = await respondentListAnswerHistory({
        question_id: questionId,
        latest_only: true,
        limit: 1,
      })
      if (response.items.length > 0) {
        setLastSubmittedAnswer(response.items[0])
      }
    } catch {
      // Silently fail
    }
  }, [questionId])

  useEffect(() => {
    loadLastSubmittedAnswer()
  }, [loadLastSubmittedAnswer])

  // Auto-save draft
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (answerText.trim() || attachments.length > 0) {
        saveDraft(answerText, attachments)
      }
    }, 3000)
    return () => clearTimeout(timeout)
  }, [answerText, attachments, saveDraft])

  // Load question
  const loadQuestion = useCallback(async () => {
    setLoading(true)
    try {
      const questionData = await respondentGetQuestion(questionId)
      setQuestion(questionData)
    } catch {
      toast({
        title: t('errors.load_failed'),
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [questionId, toast, t])

  useEffect(() => {
    loadQuestion()
  }, [loadQuestion])

  // Navigation handlers
  const handlePrevious = useCallback(() => {
    if (currentQuestionIndex > 0) {
      const prevId = questionIds[currentQuestionIndex - 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${prevId}`)
    }
  }, [currentQuestionIndex, questionIds, router, topic.id])

  const handleNext = useCallback(() => {
    if (currentQuestionIndex < totalQuestions - 1) {
      const nextId = questionIds[currentQuestionIndex + 1]
      router.push(`/evaluation/respondent/topics/${topic.id}/questions/${nextId}`)
    }
  }, [currentQuestionIndex, totalQuestions, questionIds, router, topic.id])

  // Submit handler
  const handleSubmit = useCallback(async () => {
    setSubmitting(true)
    try {
      const contentData: Record<string, unknown> = {}
      if (answerText.trim()) {
        contentData.text = answerText.trim()
      }
      if (attachments.length > 0) {
        contentData.attachments = attachments
      }

      const newAnswer = await respondentSubmitAnswer(questionId, {
        content_type: ContentType.MIXED,
        content_data: contentData,
      })

      clearDraft()
      setLastSubmittedAnswer(newAnswer)
      toast({
        title: t('answers.submit_success'),
      })

      // Reset form
      setAnswerText('')
      setAttachments([])
    } catch {
      toast({
        title: t('errors.save_failed'),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
      setShowConfirmDialog(false)
    }
  }, [answerText, attachments, questionId, clearDraft, toast, t])

  const handleSubmitClick = useCallback(() => {
    const isEmpty = answerText.trim().length === 0 && attachments.length === 0
    if (isEmpty) {
      toast({
        title: t('errors.save_failed'),
        description: t('answers.content_required'),
        variant: 'destructive',
      })
      return
    }
    setShowConfirmDialog(true)
  }, [answerText, attachments, toast, t])

  // Derived values
  const progress = useMemo(
    () => Math.round(((currentQuestionIndex + 1) / totalQuestions) * 100),
    [currentQuestionIndex, totalQuestions]
  )

  const instructions = useMemo(
    () =>
      (question?.content_data?.instructions as string)?.trim() ||
      (topic.extra_data?.instructions as string)?.trim(),
    [question, topic]
  )

  const isEmpty = useMemo(
    () => answerText.trim().length === 0 && attachments.length === 0,
    [answerText, attachments]
  )

  return {
    question,
    loading,
    answerText,
    attachments,
    lastSubmittedAnswer,
    submitting,
    showConfirmDialog,
    showTextInput,
    showLastSubmitted,
    showInstructions,
    progress,
    instructions,
    lastSaved,
    isEmpty,
    setAnswerText,
    setAttachments,
    setShowTextInput,
    setShowLastSubmitted,
    setShowInstructions,
    setShowConfirmDialog,
    handlePrevious,
    handleNext,
    handleSubmitClick,
    handleSubmit,
  }
}
```

**Step 2: Verify hook compiles**

Run: `cd frontend && npx tsc --noEmit wecode/components/evaluation/respondent/hooks/useRespondentQuestion.ts`

Expected: No errors

**Step 3: Commit**

```bash
git add frontend/wecode/components/evaluation/respondent/hooks/useRespondentQuestion.ts
git commit -m "feat(evaluation): add useRespondentQuestion shared hook"
```

---

### Task 2: Create Sub-Component - `QuestionHeader.tsx`

**Files:**
- Create: `frontend/wecode/components/evaluation/respondent/components/sub-components/QuestionHeader.tsx`
- Create: `frontend/wecode/components/evaluation/respondent/components/sub-components/index.ts`

**Step 1: Create directory and file**

```bash
mkdir -p frontend/wecode/components/evaluation/respondent/components/sub-components
```

**Step 2: Write QuestionHeader component**

```typescript
'use client'

import { ChevronLeft, ChevronRight, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'

interface QuestionHeaderProps {
  topicName: string
  progress: number
  formattedTime: string
  currentIndex: number
  totalQuestions: number
  onPrevious: () => void
  onNext: () => void
  isFirst: boolean
  isLast: boolean
}

export function QuestionHeader({
  topicName,
  progress,
  formattedTime,
  currentIndex,
  totalQuestions,
  onPrevious,
  onNext,
  isFirst,
  isLast,
}: QuestionHeaderProps) {
  const { t } = useTranslation('evaluation')
  const isMobile = useIsMobile()

  if (isMobile) {
    return (
      <>
        {/* Mobile: Top row - Topic, Progress, Timer */}
        <div className="flex h-14 items-center justify-between border-b border-border bg-surface px-4">
          <span className="text-sm font-medium text-text-primary truncate max-w-[120px]">
            {topicName}
          </span>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1">
              <span className="text-xs text-text-muted">{t('ui.progress')}</span>
              <div className="h-2 w-16 overflow-hidden rounded-full bg-border">
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
            </div>
            <div className="flex items-center gap-1 text-sm text-text-secondary">
              <Clock className="h-4 w-4" />
              <span className="text-xs text-text-muted">{t('ui.time_spent')}</span>
              <span className="tabular-nums">{formattedTime}</span>
            </div>
          </div>
        </div>

        {/* Mobile: Bottom row - Navigation */}
        <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={onPrevious}
            disabled={isFirst}
            className="h-9"
          >
            <ChevronLeft className="mr-1 h-4 w-4" />
            {t('actions.previous')}
          </Button>
          <span className="text-sm text-text-secondary">
            {currentIndex + 1} / {totalQuestions}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={onNext}
            disabled={isLast}
            className="h-9"
          >
            {t('actions.next')}
            <ChevronRight className="ml-1 h-4 w-4" />
          </Button>
        </div>
      </>
    )
  }

  // Desktop: Single row layout
  return (
    <header className="h-16 border-b border-border bg-white px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-4">
        <h1 className="font-semibold text-text-primary truncate max-w-[300px]">{topicName}</h1>
        <Badge variant="secondary" className="text-xs">
          {currentIndex + 1} / {totalQuestions}
        </Badge>
      </div>

      <div className="flex items-center gap-6">
        {/* Progress Bar */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-muted">{t('ui.progress')}</span>
          <div className="flex items-center gap-2">
            <div className="w-24 h-2 bg-border rounded-full overflow-hidden">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="text-xs text-text-secondary w-8">{progress}%</span>
          </div>
        </div>

        {/* Timer */}
        <div className="flex items-center gap-2 text-text-secondary bg-surface px-3 py-1.5 rounded-lg">
          <Clock className="h-4 w-4" />
          <span className="text-xs text-text-muted">{t('ui.time_spent')}</span>
          <span className="text-sm font-medium tabular-nums">{formattedTime}</span>
        </div>

        {/* Navigation */}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onPrevious}
            disabled={isFirst}
            className="h-9 px-4"
          >
            <ChevronLeft className="h-4 w-4 mr-1" />
            {t('actions.previous')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            disabled={isLast}
            className="h-9 px-4"
          >
            {t('actions.next')}
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </div>
      </div>
    </header>
  )
}
```

**Step 3: Create index.ts for sub-components**

```typescript
export { QuestionHeader } from './QuestionHeader'
```

**Step 4: Verify compilation**

Run: `cd frontend && npx tsc --noEmit wecode/components/evaluation/respondent/components/sub-components/QuestionHeader.tsx`

Expected: No errors

**Step 5: Commit**

```bash
git add frontend/wecode/components/evaluation/respondent/components/sub-components/
git commit -m "feat(evaluation): add QuestionHeader sub-component"
```

---

### Task 3: Create Sub-Component - `QuestionPanel.tsx`

**Files:**
- Create: `frontend/wecode/components/evaluation/respondent/components/sub-components/QuestionPanel.tsx`
- Modify: `frontend/wecode/components/evaluation/respondent/components/sub-components/index.ts`

**Step 1: Write QuestionPanel component**

```typescript
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
                  {isMobile ? (
                    <FileText className="h-4 w-4" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
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
```

**Step 2: Update index.ts**

```typescript
export { QuestionHeader } from './QuestionHeader'
export { QuestionPanel } from './QuestionPanel'
```

**Step 3: Verify and commit**

Run: `cd frontend && npx tsc --noEmit wecode/components/evaluation/respondent/components/sub-components/QuestionPanel.tsx`

Expected: No errors

```bash
git add frontend/wecode/components/evaluation/respondent/components/sub-components/
git commit -m "feat(evaluation): add QuestionPanel sub-component"
```

---

### Task 4: Create Sub-Component - `AnswerPanel.tsx`

**Files:**
- Create: `frontend/wecode/components/evaluation/respondent/components/sub-components/AnswerPanel.tsx`
- Modify: `frontend/wecode/components/evaluation/respondent/components/sub-components/index.ts`

**Step 1: Write AnswerPanel component**

```typescript
'use client'

import { Upload, Edit3, History, File, Download, ChevronDown, ChevronUp, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { EvaluationFileUpload } from '@wecode/components/evaluation/common/EvaluationFileUpload'
import { useTranslation } from '@/hooks/useTranslation'
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { MAX_BATCH_FILES } from '@/hooks/useBatchAttachment'
import { formatFileSize } from '@/apis/attachments'
import type { EvalAttachment, Answer } from '@wecode/types/evaluation'

interface AnswerPanelProps {
  answerText: string
  attachments: EvalAttachment[]
  showTextInput: boolean
  onTextChange: (text: string) => void
  onAttachmentsChange: (attachments: EvalAttachment[]) => void
  onToggleTextInput: () => void
  lastSubmittedAnswer: Answer | null
  showLastSubmitted: boolean
  onToggleLastSubmitted: () => void
  isSubmitting: boolean
  isEmpty: boolean
  lastSaved: Date | null
  onSubmitClick: () => void
  topicId: number
  questionId: number
  isResubmit: boolean
}

export function AnswerPanel({
  answerText,
  attachments,
  showTextInput,
  onTextChange,
  onAttachmentsChange,
  onToggleTextInput,
  lastSubmittedAnswer,
  showLastSubmitted,
  onToggleLastSubmitted,
  isSubmitting,
  isEmpty,
  lastSaved,
  onSubmitClick,
  topicId,
  questionId,
  isResubmit,
}: AnswerPanelProps) {
  const { t } = useTranslation('evaluation')
  const isMobile = useIsMobile()

  const lastSubmittedAttachments = lastSubmittedAnswer?.content_data?.attachments as
    | Array<{ key: string; filename: string; file_size?: number }>
    | undefined

  // Last Submitted Section
  const lastSubmittedSection = lastSubmittedAnswer && (
    <Card className={`${isMobile ? 'mb-4' : ''} border-blue-200 bg-blue-50/50`}>
      <Collapsible open={showLastSubmitted} onOpenChange={onToggleLastSubmitted}>
        <CollapsibleTrigger asChild>
          <button
            className={`w-full flex items-center justify-between text-left hover:bg-blue-50/80 transition-colors ${
              isMobile ? 'p-3' : 'p-4 rounded-t-lg'
            }`}
          >
            <div className="flex items-center gap-2 text-blue-900">
              <History className="h-4 w-4" />
              <span className={`font-medium ${isMobile ? 'text-sm' : 'text-sm'}`}>
                {t('ui.last_submitted')}
              </span>
              <span className={`text-blue-600 ${isMobile ? 'text-xs font-normal' : 'text-xs'}`}>
                (
                {new Date(lastSubmittedAnswer.submitted_at).toLocaleString('zh-CN', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                )
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={`text-blue-600 ${isMobile ? 'text-sm' : 'text-sm'}`}>
                {showLastSubmitted ? t('actions.collapse') : t('actions.expand')}
              </span>
              {showLastSubmitted ? (
                <ChevronUp className="h-4 w-4 text-blue-600" />
              ) : (
                <ChevronDown className="h-4 w-4 text-blue-600" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className={`pt-0 ${isMobile ? 'pb-3 px-3' : 'pb-4 px-4'} space-y-3`}>
            {typeof lastSubmittedAnswer.content_data?.text === 'string' && (
              <div
                className={`rounded-lg bg-white border border-blue-100 ${isMobile ? 'p-3' : 'p-3'}`}
              >
                <p className="text-sm text-text-secondary mb-2">{t('ui.text_answer')}：</p>
                <p className="text-sm text-text-primary whitespace-pre-wrap">
                  {lastSubmittedAnswer.content_data.text}
                </p>
              </div>
            )}
            {lastSubmittedAttachments && lastSubmittedAttachments.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm text-text-secondary">
                  {t('ui.attachments')} ({lastSubmittedAttachments.length})：
                </p>
                <div className="space-y-2">
                  {lastSubmittedAttachments.map((attachment, index) => (
                    <a
                      key={attachment.key || index}
                      href={`/api/evaluation/respondent/files/${attachment.key}?filename=${encodeURIComponent(attachment.filename)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`flex items-center gap-3 rounded-lg border border-blue-100 bg-white hover:bg-blue-50 transition-colors group ${
                        isMobile ? 'p-2 gap-2' : 'p-3'
                      }`}
                    >
                      <File className="h-4 w-4 text-blue-600" />
                      <span className="text-sm text-text-primary truncate flex-1">
                        {attachment.filename}
                      </span>
                      {attachment.file_size && (
                        <span className="text-xs text-text-muted">
                          {formatFileSize(attachment.file_size)}
                        </span>
                      )}
                      <Download
                        className={`h-4 w-4 text-blue-600 ${
                          isMobile ? '' : 'opacity-0 group-hover:opacity-100'
                        } transition-opacity`}
                      />
                    </a>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )

  // Text Input Section
  const textInputSection = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-text-secondary">
          {t('answers.text_supplement')}
        </span>
        {isMobile ? (
          <button
            onClick={onToggleTextInput}
            className="text-sm text-text-muted"
          >
            {showTextInput ? t('actions.collapse') : t('actions.expand')}
          </button>
        ) : (
          <Button variant="ghost" size="sm" onClick={onToggleTextInput}>
            {showTextInput ? t('actions.collapse') : t('actions.expand')}
          </Button>
        )}
      </div>
      {showTextInput && (
        <Textarea
          value={answerText}
          onChange={e => onTextChange(e.target.value)}
          placeholder={t('answers.content_placeholder')}
          className={`resize-y ${isMobile ? 'min-h-[100px]' : 'min-h-[150px]'}`}
        />
      )}
    </div>
  )

  // Submit Button
  const submitButton = (
    <Button
      variant="primary"
      onClick={onSubmitClick}
      disabled={isSubmitting || isEmpty}
      className={`${isMobile ? 'w-full h-11' : 'h-11 px-8'}`}
    >
      {!isMobile && <Send className="h-4 w-4 mr-2" />}
      {isSubmitting ? t('actions.submitting') : t('answers.submit')}
    </Button>
  )

  if (isMobile) {
    return (
      <div className="border-t border-border bg-surface p-4">
        {lastSubmittedSection}

        <h2 className="mb-3 text-base font-medium">
          {isResubmit ? t('ui.resubmit') : t('ui.submit_answer')}
        </h2>

        {/* Upload Area */}
        <Card className="mb-4 border-dashed">
          <CardContent className="p-4">
            <div className="flex flex-col items-center gap-2 text-center">
              <EvaluationFileUpload
                topicId={topicId}
                questionId={questionId}
                fileType="answer_attachment"
                attachments={attachments}
                onChange={onAttachmentsChange}
                maxFiles={MAX_BATCH_FILES}
              />
            </div>
          </CardContent>
        </Card>

        {/* Text Input */}
        {textInputSection}

        {/* Submit */}
        {submitButton}
      </div>
    )
  }

  // Desktop Layout
  return (
    <div className="overflow-y-auto bg-surface">
      {/* Panel Header */}
      <div className="sticky top-0 z-10 bg-surface border-b border-border px-8 py-4 flex items-center gap-2">
        <Edit3 className="h-5 w-5 text-primary" />
        <span className="font-medium text-text-primary">{t('ui.answer_area')}</span>
      </div>

      <div className="max-w-2xl mx-auto p-8 space-y-6">
        {lastSubmittedSection}

        {/* New Answer Form */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Upload className="h-5 w-5 text-primary" />
              {isResubmit ? t('ui.resubmit') : t('ui.submit_answer')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            {/* File Upload */}
            <div className="space-y-3">
              {attachments.length === 0 ? (
                <div className="border-2 border-dashed border-border rounded-xl p-8 text-center hover:border-primary/50 transition-colors bg-white">
                  <div className="flex flex-col items-center gap-3">
                    <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center">
                      <Upload className="h-6 w-6 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-text-primary">
                        {t('answers.upload_drag_hint')}
                      </p>
                      <p className="text-xs text-text-muted mt-1">
                        {t('answers.upload_format_hint')}
                      </p>
                    </div>
                    <EvaluationFileUpload
                      topicId={topicId}
                      questionId={questionId}
                      fileType="answer_attachment"
                      attachments={attachments}
                      onChange={onAttachmentsChange}
                      maxFiles={MAX_BATCH_FILES}
                    />
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  <EvaluationFileUpload
                    topicId={topicId}
                    questionId={questionId}
                    fileType="answer_attachment"
                    attachments={attachments}
                    onChange={onAttachmentsChange}
                    maxFiles={MAX_BATCH_FILES}
                  />
                </div>
              )}
            </div>

            <div className="h-px bg-border" />

            {/* Text Input */}
            {textInputSection}

            {/* Submit Button */}
            <div className="flex items-center justify-between pt-4">
              <div className="text-xs text-text-muted">
                {lastSaved && (
                  <span>
                    {t('answers.auto_saved')}{' '}
                    {new Date(lastSaved).toLocaleTimeString('zh-CN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                )}
              </div>
              {submitButton}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
```

**Step 2: Update index.ts**

```typescript
export { QuestionHeader } from './QuestionHeader'
export { QuestionPanel } from './QuestionPanel'
export { AnswerPanel } from './AnswerPanel'
```

**Step 3: Verify and commit**

Run: `cd frontend && npx tsc --noEmit wecode/components/evaluation/respondent/components/sub-components/AnswerPanel.tsx`

Expected: No errors

```bash
git add frontend/wecode/components/evaluation/respondent/components/sub-components/
git commit -m "feat(evaluation): add AnswerPanel sub-component"
```

---

### Task 5: Create Unified Main Component - `RespondentQuestion.tsx`

**Files:**
- Create: `frontend/wecode/components/evaluation/respondent/components/RespondentQuestion.tsx`

**Step 1: Write the unified component**

```typescript
'use client'

import { useIsMobile } from '@/features/layout/hooks/useMediaQuery'
import { useAnswerTimer } from '../hooks/useAnswerTimer'
import { useRespondentQuestion } from '../hooks/useRespondentQuestion'
import { QuestionHeader, QuestionPanel, AnswerPanel } from './sub-components'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { Topic } from '@wecode/types/evaluation'

interface RespondentQuestionProps {
  topic: Topic
  questionId: number
  currentQuestionIndex: number
  totalQuestions: number
  questionIds: number[]
}

export function RespondentQuestion({
  topic,
  questionId,
  currentQuestionIndex,
  totalQuestions,
  questionIds,
}: RespondentQuestionProps) {
  const isMobile = useIsMobile()
  const { t } = useTranslation('evaluation')
  const { formattedTime } = useAnswerTimer()

  const {
    question,
    loading,
    answerText,
    attachments,
    lastSubmittedAnswer,
    submitting,
    showConfirmDialog,
    showTextInput,
    showLastSubmitted,
    showInstructions,
    progress,
    instructions,
    lastSaved,
    isEmpty,
    setAnswerText,
    setAttachments,
    setShowTextInput,
    setShowLastSubmitted,
    setShowInstructions,
    setShowConfirmDialog,
    handlePrevious,
    handleNext,
    handleSubmitClick,
    handleSubmit,
  } = useRespondentQuestion({
    topic,
    questionId,
    currentQuestionIndex,
    totalQuestions,
    questionIds,
  })

  // Loading state
  if (loading || !question) {
    return (
      <div className={`flex h-screen flex-col ${isMobile ? '' : 'bg-surface'}`}>
        <div className={`${isMobile ? 'h-14' : 'h-16'} border-b border-border ${isMobile ? 'bg-surface' : 'bg-white'}`} />
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      </div>
    )
  }

  return (
    <div className={`flex h-screen flex-col ${isMobile ? 'bg-base' : 'bg-surface'}`}>
      {/* Header */}
      <QuestionHeader
        topicName={topic.name}
        progress={progress}
        formattedTime={formattedTime}
        currentIndex={currentQuestionIndex}
        totalQuestions={totalQuestions}
        onPrevious={handlePrevious}
        onNext={handleNext}
        isFirst={currentQuestionIndex === 0}
        isLast={currentQuestionIndex === totalQuestions - 1}
      />

      {/* Main Content */}
      {isMobile ? (
        // Mobile: Single column scrollable
        <div className="flex-1 overflow-y-auto">
          <QuestionPanel
            question={question}
            instructions={instructions}
            showInstructions={showInstructions}
            onToggleInstructions={() => setShowInstructions(!showInstructions)}
          />
          <AnswerPanel
            answerText={answerText}
            attachments={attachments}
            showTextInput={showTextInput}
            onTextChange={setAnswerText}
            onAttachmentsChange={setAttachments}
            onToggleTextInput={() => setShowTextInput(!showTextInput)}
            lastSubmittedAnswer={lastSubmittedAnswer}
            showLastSubmitted={showLastSubmitted}
            onToggleLastSubmitted={() => setShowLastSubmitted(!showLastSubmitted)}
            isSubmitting={submitting}
            isEmpty={isEmpty}
            lastSaved={lastSaved}
            onSubmitClick={handleSubmitClick}
            topicId={topic.id}
            questionId={questionId}
            isResubmit={!!lastSubmittedAnswer}
          />
        </div>
      ) : (
        // Desktop: Two-column grid
        <div className="flex-1 grid grid-cols-2 gap-0 overflow-hidden">
          <QuestionPanel
            question={question}
            instructions={instructions}
            showInstructions={showInstructions}
            onToggleInstructions={() => setShowInstructions(!showInstructions)}
          />
          <AnswerPanel
            answerText={answerText}
            attachments={attachments}
            showTextInput={showTextInput}
            onTextChange={setAnswerText}
            onAttachmentsChange={setAttachments}
            onToggleTextInput={() => setShowTextInput(!showTextInput)}
            lastSubmittedAnswer={lastSubmittedAnswer}
            showLastSubmitted={showLastSubmitted}
            onToggleLastSubmitted={() => setShowLastSubmitted(!showLastSubmitted)}
            isSubmitting={submitting}
            isEmpty={isEmpty}
            lastSaved={lastSaved}
            onSubmitClick={handleSubmitClick}
            topicId={topic.id}
            questionId={questionId}
            isResubmit={!!lastSubmittedAnswer}
          />
        </div>
      )}

      {/* Confirm Dialog */}
      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('answers.confirm_submit_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('answers.confirm_submit_description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleSubmit}>{t('actions.confirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
```

**Step 2: Verify compilation**

Run: `cd frontend && npx tsc --noEmit wecode/components/evaluation/respondent/components/RespondentQuestion.tsx`

Expected: No errors

**Step 3: Commit**

```bash
git add frontend/wecode/components/evaluation/respondent/components/RespondentQuestion.tsx
git commit -m "feat(evaluation): add unified RespondentQuestion component"
```

---

### Task 6: Update Component Exports

**Files:**
- Modify: `frontend/wecode/components/evaluation/respondent/components/index.ts`

**Step 1: Update exports**

```typescript
// Export unified component
export { RespondentQuestion } from './RespondentQuestion'

// Export sub-components (for advanced use cases)
export { QuestionHeader, QuestionPanel, AnswerPanel } from './sub-components'

// Export hooks
export { useRespondentQuestion } from '../hooks/useRespondentQuestion'

// Legacy exports - REMOVE these after migration
// export { RespondentQuestionDesktop } from './RespondentQuestionDesktop'
// export { RespondentQuestionMobile } from './RespondentQuestionMobile';
```

**Step 2: Commit**

```bash
git add frontend/wecode/components/evaluation/respondent/components/index.ts
git commit -m "feat(evaluation): update component exports for unified component"
```

---

### Task 7: Update Page Router

**Files:**
- Modify: `frontend/src/app/(tasks)/evaluation/respondent/topics/[id]/questions/[qid]/page.tsx`

**Step 1: Update page to use unified component**

```typescript
// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import { respondentGetTopic, respondentListQuestions } from '@wecode/api/evaluation-respondent'
import { RespondentQuestion } from '@wecode/components/evaluation/respondent/components'
import type { Topic } from '@wecode/types/evaluation'

export default function RespondentQuestionPage() {
  const params = useParams()
  const router = useRouter()
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const topicId = parseInt(params.id as string)
  const questionId = parseInt(params.qid as string)

  const [topic, setTopic] = useState<Topic | null>(null)
  const [questionIds, setQuestionIds] = useState<number[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadData = async () => {
      setLoading(true)
      try {
        const [topicData, questionsData] = await Promise.all([
          respondentGetTopic(topicId),
          respondentListQuestions(topicId, {}),
        ])
        setTopic(topicData)
        setQuestionIds(questionsData.items.map(q => q.id))
      } catch {
        toast({
          title: t('errors.load_failed'),
          description: t('errors.permission_denied'),
          variant: 'destructive',
        })
        router.push('/evaluation/respondent')
      } finally {
        setLoading(false)
      }
    }

    if (topicId) {
      loadData()
    }
  }, [topicId, toast, t, router])

  if (loading || !topic) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    )
  }

  const currentQuestionIndex = questionIds.findIndex(id => id === questionId)

  if (currentQuestionIndex === -1) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-text-muted">{t('errors.question_not_found')}</p>
      </div>
    )
  }

  // Use unified component - responsive layout handled internally
  return (
    <RespondentQuestion
      topic={topic}
      questionId={questionId}
      currentQuestionIndex={currentQuestionIndex}
      totalQuestions={questionIds.length}
      questionIds={questionIds}
    />
  )
}
```

**Step 2: Verify compilation**

Run: `cd frontend && npx tsc --noEmit src/app/(tasks)/evaluation/respondent/topics/[id]/questions/[qid]/page.tsx`

Expected: No errors

**Step 3: Commit**

```bash
git add frontend/src/app/(tasks)/evaluation/respondent/topics/[id]/questions/[qid]/page.tsx
git commit -m "refactor(evaluation): update page to use unified RespondentQuestion component"
```

---

### Task 8: Delete Legacy Components

**Files:**
- Delete: `frontend/wecode/components/evaluation/respondent/components/RespondentQuestionDesktop.tsx`
- Delete: `frontend/wecode/components/evaluation/respondent/components/RespondentQuestionMobile.tsx`

**Step 1: Remove old files**

```bash
git rm frontend/wecode/components/evaluation/respondent/components/RespondentQuestionDesktop.tsx
git rm frontend/wecode/components/evaluation/respondent/components/RespondentQuestionMobile.tsx
```

**Step 2: Commit**

```bash
git commit -m "refactor(evaluation): remove legacy Desktop/Mobile components"
```

---

### Task 9: Build Verification

**Step 1: Run TypeScript check**

Run: `cd frontend && npm run type-check`

Expected: No errors

**Step 2: Run build**

Run: `cd frontend && npm run build`

Expected: Build succeeds

**Step 3: Run lint**

Run: `cd frontend && npm run lint`

Expected: No errors

**Step 4: Commit if all checks pass**

```bash
git commit -m "chore(evaluation): verify build after component unification"
```

---

## Summary

| File | Action | Lines |
|------|--------|-------|
| `hooks/useRespondentQuestion.ts` | Create | ~280 |
| `components/sub-components/QuestionHeader.tsx` | Create | ~130 |
| `components/sub-components/QuestionPanel.tsx` | Create | ~120 |
| `components/sub-components/AnswerPanel.tsx` | Create | ~280 |
| `components/sub-components/index.ts` | Create | ~4 |
| `components/RespondentQuestion.tsx` | Create | ~150 |
| `components/index.ts` | Modify | ~10 |
| `page.tsx` | Modify | ~75 |
| `RespondentQuestionDesktop.tsx` | Delete | ~570 |
| `RespondentQuestionMobile.tsx` | Delete | ~470 |

**Net change:** -~550 lines, +~960 lines, but much better maintainability through:
- Single source of truth for business logic
- Clear separation of concerns
- Responsive layout co-located in components
- Reusable sub-components
