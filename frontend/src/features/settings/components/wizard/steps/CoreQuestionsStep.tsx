// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Lightbulb, ChevronDown, ChevronRight } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useTranslation } from '@/hooks/useTranslation'
import type { WizardAnswers } from '@/apis/wizard'

interface CoreQuestionsStepProps {
  answers: WizardAnswers
  onChange: (answers: Partial<WizardAnswers>) => void
}

export default function CoreQuestionsStep({ answers, onChange }: CoreQuestionsStepProps) {
  const { t } = useTranslation()
  const [isIntroExpanded, setIsIntroExpanded] = useState(false)

  return (
    <div className="space-y-6">
      {/* Agent Introduction - Collapsible */}
      <div className="border border-primary/20 rounded-lg overflow-hidden">
        <button
          type="button"
          onClick={() => setIsIntroExpanded(!isIntroExpanded)}
          className="w-full p-3 bg-primary/5 flex items-center gap-3 hover:bg-primary/10 transition-colors text-left"
        >
          <Lightbulb className="w-5 h-5 text-primary flex-shrink-0" />
          <span className="font-medium text-text-primary flex-1">{t('wizard:intro_title')}</span>
          {isIntroExpanded ? (
            <ChevronDown className="w-4 h-4 text-text-muted" />
          ) : (
            <ChevronRight className="w-4 h-4 text-text-muted" />
          )}
        </button>
        {isIntroExpanded && (
          <div className="p-4 bg-primary/5 border-t border-primary/10">
            <div className="space-y-2">
              <p className="text-sm text-text-secondary">{t('wizard:intro_description')}</p>
              <div className="text-sm text-text-muted">
                <p className="font-medium mb-1">{t('wizard:intro_when_to_create')}</p>
                <ul className="list-disc list-inside space-y-1 ml-1">
                  <li>{t('wizard:intro_scenario_1')}</li>
                  <li>{t('wizard:intro_scenario_2')}</li>
                  <li>{t('wizard:intro_scenario_3')}</li>
                </ul>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Question 1: Purpose (Required) */}
      <div className="space-y-2">
        <Label className="text-base font-medium">
          {t('wizard:q1_purpose')} <span className="text-error">*</span>
        </Label>
        <p className="text-sm text-text-muted">{t('wizard:q1_hint')}</p>
        <Textarea
          value={answers.purpose}
          onChange={e => onChange({ purpose: e.target.value })}
          placeholder={t('wizard:q1_placeholder')}
          className="min-h-[80px]"
        />
      </div>

      {/* Question 2: Special Requirements (Optional) */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard:q2_requirements')}</Label>
        <p className="text-sm text-text-muted">{t('wizard:q2_hint')}</p>
        <Textarea
          value={answers.special_requirements || ''}
          onChange={e => onChange({ special_requirements: e.target.value })}
          placeholder={t('wizard:q2_placeholder')}
          className="min-h-[60px]"
        />
      </div>
    </div>
  )
}
