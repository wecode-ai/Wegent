// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { Lightbulb } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useTranslation } from '@/hooks/useTranslation';
import type { WizardAnswers } from '@/apis/wizard';

interface CoreQuestionsStepProps {
  answers: WizardAnswers;
  onChange: (answers: Partial<WizardAnswers>) => void;
}

export default function CoreQuestionsStep({ answers, onChange }: CoreQuestionsStepProps) {
  const { t } = useTranslation('common');

  return (
    <div className="space-y-6">
      {/* Agent Introduction */}
      <div className="p-4 bg-primary/5 border border-primary/20 rounded-lg">
        <div className="flex items-start gap-3">
          <Lightbulb className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
          <div className="space-y-2">
            <h3 className="font-medium text-text-primary">{t('wizard.intro_title')}</h3>
            <p className="text-sm text-text-secondary">{t('wizard.intro_description')}</p>
            <div className="text-sm text-text-muted">
              <p className="font-medium mb-1">{t('wizard.intro_when_to_create')}</p>
              <ul className="list-disc list-inside space-y-1 ml-1">
                <li>{t('wizard.intro_scenario_1')}</li>
                <li>{t('wizard.intro_scenario_2')}</li>
                <li>{t('wizard.intro_scenario_3')}</li>
              </ul>
            </div>
          </div>
        </div>
      </div>

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
          className="min-h-[80px]"
        />
      </div>

      {/* Question 2: Example Input */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q2_example_input')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q2_example_input_hint')}</p>
        <Textarea
          value={answers.example_input || ''}
          onChange={e => onChange({ example_input: e.target.value })}
          placeholder={t('wizard.q2_example_input_placeholder')}
          className="min-h-[80px]"
        />
      </div>

      {/* Question 3: Expected Output */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q3_expected_output')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q3_expected_output_hint')}</p>
        <Textarea
          value={answers.expected_output || ''}
          onChange={e => onChange({ expected_output: e.target.value })}
          placeholder={t('wizard.q3_expected_output_placeholder')}
          className="min-h-[80px]"
        />
      </div>

      {/* Question 4: Special Requirements (Optional) */}
      <div className="space-y-2">
        <Label className="text-base font-medium">{t('wizard.q4_requirements')}</Label>
        <p className="text-sm text-text-muted">{t('wizard.q4_hint')}</p>
        <Textarea
          value={answers.special_requirements || ''}
          onChange={e => onChange({ special_requirements: e.target.value })}
          placeholder={t('wizard.q4_placeholder')}
          className="min-h-[60px]"
        />
      </div>
    </div>
  );
}
