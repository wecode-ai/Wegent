// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { ClipboardList, Info } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import { Alert, AlertDescription } from '@/components/ui/alert'

interface AnswersTabProps {
  topicId: number
}

export function AnswersTab({ topicId: _topicId }: AnswersTabProps) {
  const { t } = useTranslation('evaluation')

  return (
    <div className="space-y-6">
      {/* Answers Card */}
      <Card className="bg-white rounded-2xl shadow-sm border border-gray-100">
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <ClipboardList className="h-5 w-5 text-primary" />
                {t('answer_records.title')}
              </CardTitle>
              <CardDescription className="text-sm text-text-secondary mt-1">
                {t('answer_records.description')}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Alert className="bg-blue-50 border-blue-200">
            <Info className="h-4 w-4 text-blue-600" />
            <AlertDescription className="text-blue-700">
              {t('answer_records.use_exam_sessions')}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  )
}
