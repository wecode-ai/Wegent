// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import React from 'react';
import { useTranslation } from 'react-i18next';

interface OpenRouterModelFormProps {
  formData: Record<string, any>;
  onChange: (field: string, value: string) => void;
  errors?: Record<string, boolean>;
}

const OpenRouterModelForm: React.FC<OpenRouterModelFormProps> = ({
  formData,
  onChange,
  errors = {},
}) => {
  const { t } = useTranslation('common');

  return (
    <div className="space-y-3">
      <div className="flex flex-col">
        <label className="block text-base font-medium text-text-primary mb-1">
          {t('settings.model.model_id')} <span className="text-red-400">*</span>
        </label>
        <input
          type="text"
          value={formData.model_id || ''}
          onChange={e => onChange('model_id', e.target.value)}
          placeholder={t('settings.model.model_id_placeholder')}
          className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 text-base ${
            errors.model_id
              ? 'border border-red-400 focus:ring-red-300'
              : 'border border-transparent focus:ring-primary/40'
          }`}
        />
      </div>

      <div className="flex flex-col">
        <label className="block text-base font-medium text-text-primary mb-1">
          {t('settings.model.api_key')} <span className="text-red-400">*</span>
        </label>
        <input
          type="password"
          value={formData.api_key || ''}
          onChange={e => onChange('api_key', e.target.value)}
          placeholder={t('settings.model.api_key_placeholder')}
          className={`w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 text-base ${
            errors.api_key
              ? 'border border-red-400 focus:ring-red-300'
              : 'border border-transparent focus:ring-primary/40'
          }`}
        />
      </div>

      <div className="flex flex-col">
        <label className="block text-base font-medium text-text-primary mb-1">
          {t('settings.model.base_url')}
        </label>
        <input
          type="text"
          value={formData.base_url || ''}
          onChange={e => onChange('base_url', e.target.value)}
          placeholder="https://openrouter.ai/api/v1"
          className="w-full px-4 py-2 bg-base rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary/40 border border-transparent text-base"
        />
      </div>
    </div>
  );
};

export default OpenRouterModelForm;
