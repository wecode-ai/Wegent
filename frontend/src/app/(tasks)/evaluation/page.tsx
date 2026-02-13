// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useRouter } from 'next/navigation'
import { ClipboardCheck, PenTool, FileText, Award, ArrowRight } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { EvaluationPageLayout } from '@wecode/components/evaluation/common/EvaluationPageLayout'
import { useTranslation } from '@/hooks/useTranslation'

function EvaluationContent() {
  const router = useRouter()
  const { t } = useTranslation('evaluation')

  const roleCards = [
    {
      role: 'creator',
      icon: PenTool,
      title: t('roles.creator'),
      description: t('creator.my_topics_description'),
      primaryAction: {
        label: t('creator.my_topics'),
        href: '/evaluation/author',
      },
      secondaryAction: {
        label: t('topics.create'),
        href: '/evaluation/author/topics/new',
      },
    },
    {
      role: 'respondent',
      icon: FileText,
      title: t('roles.respondent'),
      description: t('topics.browse_description'),
      primaryAction: {
        label: t('topics.browse'),
        href: '/evaluation/respondent',
      },
      secondaryAction: {
        label: t('answers.history'),
        href: '/evaluation/respondent/history',
      },
    },
    {
      role: 'grader',
      icon: Award,
      title: t('roles.grader'),
      description: t('grader.tasks_description'),
      primaryAction: {
        label: t('grading.tasks'),
        href: '/evaluation/grader',
      },
      secondaryAction: {
        label: t('grading.my_reports'),
        href: '/evaluation/grader/reports',
      },
    },
  ]

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
          <ClipboardCheck className="h-6 w-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">{t('title')}</h1>
          <p className="text-sm text-text-secondary">{t('description')}</p>
        </div>
      </div>

      {/* Role Cards */}
      <div className="grid gap-6">
        {roleCards.map(card => (
          <Card key={card.role} className="overflow-hidden">
            <CardHeader className="bg-surface/50">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                  <card.icon className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">{card.title}</CardTitle>
                  <CardDescription>{card.description}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="primary"
                  onClick={() => router.push(card.primaryAction.href)}
                >
                  {card.primaryAction.label}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
                <Button variant="outline" onClick={() => router.push(card.secondaryAction.href)}>
                  {card.secondaryAction.label}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

export default function EvaluationPage() {
  return (
    <EvaluationPageLayout>
      <EvaluationContent />
    </EvaluationPageLayout>
  )
}
