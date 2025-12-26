// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback } from 'react';
import { modelApis, UnifiedModel } from '@/apis/models';

/**
 * Hook to fetch embedding models with scope support.
 *
 * @param scope - Resource scope: 'personal', 'group', or 'all'
 * @param groupName - Group name (required when scope is 'group')
 */
export function useEmbeddingModels(scope?: 'personal' | 'group' | 'all', groupName?: string) {
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true);
      // Use modelApis.getUnifiedModels with scope support and filter by embedding type
      const response = await modelApis.getUnifiedModels(
        undefined, // shellType
        false, // includeConfig
        scope || 'all', // scope - default to 'all' to include personal + group + public models
        groupName, // groupName
        'embedding' // modelCategoryType - filter by embedding models
      );
      setModels(response?.data || []);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [scope, groupName]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return { models, loading, error, refetch: fetchModels };
}
