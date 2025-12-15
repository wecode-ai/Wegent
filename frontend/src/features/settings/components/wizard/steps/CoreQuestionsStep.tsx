// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Checkbox } from '@/components/ui/checkbox'
import { useTranslation } from '@/hooks/useTranslation'
import type { WizardAnswers } from '@/apis/wizard'

interface CoreQuestionsStepProps {
  answers: WizardAnswers
  onChange: (answers: Partial<WizardAnswers>) => void
}

const interactionStyles = ['Q&A Style', 'Guided Style', 'Proactive Style']
const outputFormats = ['Code', 'Documentation', 'Lists', 'Conversation', 'Charts/Diagrams']

export default function CoreQuestionsStep({ answers, onChange }: CoreQuestionsStepProps) {
  const { t } = useTranslation('common')

  const handleOutputFormatChange = (format: string, checked: boolean) => {
    const current = answers.output_format || []
    const newFormats = checked
      ? [...current, format]
      : current.filter(f => f !== format)
    onChange({ output_format: newFormats })
  }

  return (
    <div className="space-y-6">
      {/* Question 1: Purpose (Required) */}
      <div className="space-y-2">
        <Label className="text-base font-medium">
          {t('wizard.q1_purpose')} <span className="text-error">*</span>
        </Label>
        <p className="text-sm text-text-muted">{t('wizard.q1_hint')}</p>
        <Textarea
          value={answers.purpose}
          onChange={e => onChange({ purpose: e.target.value })}
          placeholder={t('wizard.q1_placeholder')}
          className="min-h-[100px]"
        />
      </div>

      {/* Question 2: Knowledge Domain */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q2_knowledge')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q2_hint')}</p>
        <Input
          value={answers.knowledge_domain || ''}
          onChange={e => onChange({ knowledge_domain: e.target.value })}
          placeholder={t('wizard.q2_placeholder')}
        />
      </div>

      {/* Question 3: Interaction Style */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q3_interaction')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q3_hint')}</p>
        <RadioGroup
          value={answers.interaction_style || ''}
          onValueChange={value => onChange({ interaction_style: value })}
          className="flex flex-wrap gap-4 mt-2"
        >
          {interactionStyles.map(style => (
            <div key={style} className="flex items-center space-x-2">
              <RadioGroupItem value={style} id={`style-${style}`} />
              <Label htmlFor={`style-${style}`} className="font-normal cursor-pointer">
                {t(`wizard.interaction_${style.toLowerCase().replace(/\s+/g, '_')}`)}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      {/* Question 4: Output Format */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q4_output')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q4_hint')}</p>
        <div className="flex flex-wrap gap-4 mt-2">
          {outputFormats.map(format => {
            const isChecked = (answers.output_format || []).includes(format)
            return (
              <div key={format} className="flex items-center space-x-2">
                <Checkbox
                  id={`format-${format}`}
                  checked={isChecked}
                  onCheckedChange={checked => handleOutputFormatChange(format, !!checked)}
                />
                <Label htmlFor={`format-${format}`} className="font-normal cursor-pointer">
                  {t(`wizard.output_${format.toLowerCase().replace(/[/\s]+/g, '_')}`)}
                </Label>
              </div>
            )
          })}
        </div>
      </div>

      {/* Question 5: Constraints */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q5_constraints')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q5_hint')}</p>
        <Textarea
          value={answers.constraints || ''}
          onChange={e => onChange({ constraints: e.target.value })}
          placeholder={t('wizard.q5_placeholder')}
          className="min-h-[80px]"
        />
      </div>
    </div>
  )
}
