// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import { useState, useEffect } from 'react';
import { Button, message } from 'antd';
import { FiSend } from 'react-icons/fi';
import type { ClarificationData, ClarificationAnswer } from '@/types/api';
import ClarificationQuestion from './ClarificationQuestion';
import { useTranslation } from '@/hooks/useTranslation';
import { sendMessage } from '../service/messageService';
import { useTaskContext } from '../contexts/taskContext';

interface ClarificationFormProps {
  data: ClarificationData;
  taskId: number;
}

export default function ClarificationForm({ data, taskId }: ClarificationFormProps) {
  const { t } = useTranslation('chat');
  const { selectedTeam, selectedRepo, selectedBranch, refreshSelectedTaskDetail } = useTaskContext();
  const [answers, setAnswers] = useState<Map<string, { answer_type: 'choice' | 'custom'; value: string | string[] }>>(new Map());
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize default answers for questions with recommended options
  useEffect(() => {
    const initialAnswers = new Map<string, { answer_type: 'choice' | 'custom'; value: string | string[] }>();

    data.questions.forEach(question => {
      if (question.question_type === 'single_choice') {
        const recommendedOption = question.options?.find(opt => opt.recommended);
        if (recommendedOption) {
          initialAnswers.set(question.question_id, {
            answer_type: 'choice',
            value: recommendedOption.value,
          });
        }
      } else if (question.question_type === 'multiple_choice') {
        const recommendedOptions = question.options?.filter(opt => opt.recommended) || [];
        if (recommendedOptions.length > 0) {
          initialAnswers.set(question.question_id, {
            answer_type: 'choice',
            value: recommendedOptions.map(opt => opt.value),
          });
        }
      }
    });

    setAnswers(initialAnswers);
  }, [data.questions]);

  const handleAnswerChange = (questionId: string, answer: { answer_type: 'choice' | 'custom'; value: string | string[] }) => {
    if (isSubmitted) return;

    setAnswers(prev => {
      const newAnswers = new Map(prev);
      newAnswers.set(questionId, answer);
      return newAnswers;
    });
  };

  const handleSubmit = async () => {
    // Validate all questions are answered
    const unansweredQuestions = data.questions.filter(q => {
      const answer = answers.get(q.question_id);
      if (!answer) return true;

      if (answer.answer_type === 'custom') {
        return !answer.value || (typeof answer.value === 'string' && answer.value.trim() === '');
      }

      if (Array.isArray(answer.value)) {
        return answer.value.length === 0;
      }

      return !answer.value;
    });

    if (unansweredQuestions.length > 0) {
      message.warning(
        t('clarification.please_answer_all') || 'Please answer all questions before submitting'
      );
      return;
    }

    // Build answer payload with question text and labels
    const answerPayload: ClarificationAnswer[] = Array.from(answers.entries()).map(
      ([question_id, answer]) => {
        const question = data.questions.find(q => q.question_id === question_id);

        const payload: ClarificationAnswer = {
          question_id,
          question_text: question?.question_text || '',
          answer_type: answer.answer_type,
          value: answer.value,
        };

        // For choice answers, include the selected labels
        if (answer.answer_type === 'choice' && question?.options) {
          if (Array.isArray(answer.value)) {
            // Multiple choice: find labels for all selected values
            payload.selected_labels = answer.value
              .map(val => question.options?.find(opt => opt.value === val)?.label)
              .filter(Boolean) as string[];
          } else {
            // Single choice: find label for the selected value
            const selectedOption = question.options.find(opt => opt.value === answer.value);
            payload.selected_labels = selectedOption?.label || answer.value;
          }
        }

        return payload;
      }
    );

    const payload = {
      type: 'clarification_answer' as const,
      answers: answerPayload,
    };

    setIsSubmitting(true);

    try {
      // Send answer as JSON string
      const result = await sendMessage({
        message: JSON.stringify(payload),
        team: selectedTeam,
        repo: selectedRepo,
        branch: selectedBranch,
        task_id: taskId,
      });

      if (result.error) {
        message.error(result.error);
      } else {
        setIsSubmitted(true);
        message.success(t('clarification.submitted') || 'Answers submitted successfully');
        // Refresh task detail to get new messages
        setTimeout(() => {
          refreshSelectedTaskDetail();
        }, 1000);
      }
    } catch (error) {
      message.error(t('clarification.submit_failed') || 'Failed to submit answers');
      console.error('Submit clarification answers error:', error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4 p-4 rounded-lg border border-purple-500/30 bg-purple-500/5">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-lg">🤔</span>
        <h3 className="text-base font-semibold text-purple-400">
          {t('clarification.title') || 'PM Battle - Requirement Clarification'}
        </h3>
      </div>

      <div className="space-y-4">
        {data.questions.map(question => (
          <div
            key={question.question_id}
            className="p-3 rounded bg-surface/50 border border-border"
          >
            <ClarificationQuestion
              question={question}
              answer={answers.get(question.question_id) || null}
              onChange={answer => handleAnswerChange(question.question_id, answer)}
              readonly={isSubmitted}
            />
          </div>
        ))}
      </div>

      {!isSubmitted && (
        <div className="flex justify-end pt-2">
          <Button
            type="primary"
            icon={<FiSend className="w-4 h-4" />}
            onClick={handleSubmit}
            loading={isSubmitting}
            size="large"
          >
            {t('clarification.submit_answers') || 'Submit Answers'}
          </Button>
        </div>
      )}

      {isSubmitted && (
        <div className="text-sm text-green-400 text-center py-2">
          ✓ {t('clarification.form_submitted') || 'Form submitted. Waiting for response...'}
        </div>
      )}
    </div>
  );
}
