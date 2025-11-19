// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState } from 'react';
import { Radio, Checkbox, Input, Button } from 'antd';
import type { ClarificationQuestion as ClarificationQuestionType } from '@/types/api';
import { useTranslation } from '@/hooks/useTranslation';
import { FiEdit3 } from 'react-icons/fi';

const { TextArea } = Input;

interface ClarificationQuestionProps {
  question: ClarificationQuestionType;
  answer: {
    answer_type: 'choice' | 'custom';
    value: string | string[];
  } | null;
  onChange: (answer: { answer_type: 'choice' | 'custom'; value: string | string[] }) => void;
  readonly?: boolean;
}

export default function ClarificationQuestion({
  question,
  answer,
  onChange,
  readonly = false,
}: ClarificationQuestionProps) {
  const { t } = useTranslation('chat');
  const [isCustomMode, setIsCustomMode] = useState(answer?.answer_type === 'custom');

  const handleToggleCustomMode = () => {
    if (readonly) return;
    const newCustomMode = !isCustomMode;
    setIsCustomMode(newCustomMode);

    if (newCustomMode) {
      // Switch to custom mode, clear current selection
      onChange({ answer_type: 'custom', value: '' });
    } else {
      // Switch back to choice mode, set default selected option
      const defaultOption = question.options?.find(opt => opt.recommended);
      if (defaultOption) {
        onChange({
          answer_type: 'choice',
          value: question.question_type === 'multiple_choice' ? [defaultOption.value] : defaultOption.value,
        });
      } else {
        onChange({
          answer_type: 'choice',
          value: question.question_type === 'multiple_choice' ? [] : '',
        });
      }
    }
  };

  const renderChoices = () => {
    if (question.question_type === 'single_choice') {
      return (
        <Radio.Group
          value={answer?.answer_type === 'choice' ? answer.value : ''}
          onChange={e => onChange({ answer_type: 'choice', value: e.target.value })}
          disabled={readonly}
          className="flex flex-col gap-2"
        >
          {question.options?.map(option => (
            <Radio key={option.value} value={option.value}>
              {option.label}
              {option.recommended && (
                <span className="ml-2 text-xs text-blue-400">
                  ({t('clarification.recommended') || 'Recommended'})
                </span>
              )}
            </Radio>
          ))}
        </Radio.Group>
      );
    }

    if (question.question_type === 'multiple_choice') {
      return (
        <Checkbox.Group
          value={
            answer?.answer_type === 'choice' && Array.isArray(answer.value) ? answer.value : []
          }
          onChange={values => onChange({ answer_type: 'choice', value: values as string[] })}
          disabled={readonly}
          className="flex flex-col gap-2"
        >
          {question.options?.map(option => (
            <Checkbox key={option.value} value={option.value}>
              {option.label}
              {option.recommended && (
                <span className="ml-2 text-xs text-blue-400">
                  ({t('clarification.recommended') || 'Recommended'})
                </span>
              )}
            </Checkbox>
          ))}
        </Checkbox.Group>
      );
    }

    return null;
  };

  const renderCustomInput = () => {
    return (
      <TextArea
        value={answer?.answer_type === 'custom' ? (answer.value as string) : ''}
        onChange={e => onChange({ answer_type: 'custom', value: e.target.value })}
        placeholder={t('clarification.custom_input_placeholder') || 'Enter your custom input...'}
        disabled={readonly}
        rows={3}
        className="w-full"
      />
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between">
        <div className="text-sm font-medium text-text-primary">{question.question_text}</div>
        {question.question_type !== 'text_input' && !readonly && (
          <Button
            type="link"
            size="small"
            onClick={handleToggleCustomMode}
            icon={<FiEdit3 className="w-3 h-3" />}
            className="text-xs"
          >
            {isCustomMode
              ? t('clarification.back_to_choices') || 'Back to Choices'
              : t('clarification.custom_input') || 'Custom Input'}
          </Button>
        )}
      </div>

      {question.question_type === 'text_input' ? (
        renderCustomInput()
      ) : isCustomMode ? (
        renderCustomInput()
      ) : (
        renderChoices()
      )}

      {readonly && answer && (
        <div className="text-xs text-text-tertiary italic">
          {answer.answer_type === 'custom'
            ? `${t('clarification.custom_answer') || 'Custom'}: ${answer.value}`
            : `${t('clarification.selected') || 'Selected'}: ${
                Array.isArray(answer.value)
                  ? answer.value
                      .map(
                        v => question.options?.find(opt => opt.value === v)?.label || v
                      )
                      .join(', ')
                  : question.options?.find(opt => opt.value === answer.value)?.label ||
                    answer.value
              }`}
        </div>
      )}
    </div>
  );
}
