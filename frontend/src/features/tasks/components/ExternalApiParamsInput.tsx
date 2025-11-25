// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Label } from '@/components/ui/label';
import { teamApis } from '@/apis/team';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';

interface ExternalApiParamsInputProps {
  teamId: number;
  onParamsChange: (params: Record<string, string>) => void;
  initialParams?: Record<string, string>;
}

interface ParameterField {
  variable: string;
  label: Record<string, string>;
  required: boolean;
  type: string;
  options?: string[];
}

/**
 * Generic external API parameters input component
 * Works with any external API type (Dify, etc.) without exposing implementation details
 * Parameters are fetched through team API based on team_id
 */
export default function ExternalApiParamsInput({
  teamId,
  onParamsChange,
  initialParams = {},
}: ExternalApiParamsInputProps) {
  const { t } = useTranslation('common');
  const [isLoading, setIsLoading] = useState(false);
  const [paramFields, setParamFields] = useState<ParameterField[]>([]);
  const [paramValues, setParamValues] = useState<Record<string, string>>(initialParams);
  const [error, setError] = useState<string>('');

  // Fetch parameters from backend using team_id
  const fetchParameters = useCallback(async () => {
    if (!teamId) return;

    setIsLoading(true);
    setError('');

    try {
      const response = await teamApis.getTeamInputParameters(teamId);

      if (response.has_parameters) {
        const fields = response.parameters || [];
        setParamFields(fields);

        // Initialize param values with existing values or empty strings
        const initialValues = fields.reduce(
          (acc, field) => {
            acc[field.variable] = initialParams[field.variable] || '';
            return acc;
          },
          {} as Record<string, string>
        );
        setParamValues(initialValues);
        onParamsChange(initialValues);
      } else {
        setParamFields([]);
      }
    } catch (err) {
      console.error('Failed to fetch team parameters:', err);
      setError('Failed to load application parameters');
      setParamFields([]);
    } finally {
      setIsLoading(false);
    }
  }, [teamId, initialParams, onParamsChange]);

  // Fetch parameters when component mounts or teamId changes
  useEffect(() => {
    fetchParameters();
  }, [fetchParameters]);

  // Update params when values change
  const handleParamChange = useCallback(
    (variable: string, value: string) => {
      const newValues = { ...paramValues, [variable]: value };
      setParamValues(newValues);
      onParamsChange(newValues);
    },
    [paramValues, onParamsChange]
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-4 text-text-muted">
        <Loader2 className="w-4 h-4 animate-spin mr-2" />
        <span className="text-sm">Loading parameters...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-sm text-red-500 py-2">
        {error}
      </div>
    );
  }

  if (paramFields.length === 0) {
    return null; // No parameters to display
  }

  return (
    <div className="w-full mb-4">
      <Accordion type="single" collapsible defaultValue="params">
        <AccordionItem value="params" className="border rounded-lg">
          <AccordionTrigger className="px-4 py-3 hover:no-underline">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">
                {t('bot.dify_app_parameters') || 'Application Parameters'}
              </span>
              <span className="text-xs text-text-muted">
                ({paramFields.length} {t('bot.dify_parameters_count') || 'parameters'})
              </span>
            </div>
          </AccordionTrigger>
          <AccordionContent className="px-4 pb-4">
            <div className="space-y-3">
              <p className="text-xs text-text-muted">
                {t('bot.dify_parameters_hint') ||
                  'Configure the input parameters for this application.'}
              </p>
              {paramFields.map((field) => (
                <div key={field.variable} className="flex flex-col">
                  <Label
                    htmlFor={`param-${field.variable}`}
                    className="text-sm font-medium text-text-primary mb-1"
                  >
                    {field.label?.en || field.label?.['en-US'] || field.variable}
                    {field.required && <span className="text-red-400 ml-1">*</span>}
                  </Label>

                  {field.type === 'select' && field.options ? (
                    <select
                      id={`param-${field.variable}`}
                      value={paramValues[field.variable] || ''}
                      onChange={(e) => handleParamChange(field.variable, e.target.value)}
                      className="w-full px-3 py-2 bg-base rounded-md text-text-primary border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm"
                    >
                      <option value="">Select...</option>
                      {field.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  ) : field.type === 'text-input' || field.type === 'paragraph' ? (
                    <textarea
                      id={`param-${field.variable}`}
                      value={paramValues[field.variable] || ''}
                      onChange={(e) => handleParamChange(field.variable, e.target.value)}
                      placeholder={field.label?.en || field.label?.['en-US'] || ''}
                      rows={field.type === 'paragraph' ? 3 : 2}
                      className="w-full px-3 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm resize-none"
                    />
                  ) : (
                    <input
                      id={`param-${field.variable}`}
                      type="text"
                      value={paramValues[field.variable] || ''}
                      onChange={(e) => handleParamChange(field.variable, e.target.value)}
                      placeholder={field.label?.en || field.label?.['en-US'] || ''}
                      className="w-full px-3 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 text-sm"
                    />
                  )}
                </div>
              ))}
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}
