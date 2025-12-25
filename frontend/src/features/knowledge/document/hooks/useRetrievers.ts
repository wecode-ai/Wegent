// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback } from 'react';
import { retrieverApis, type UnifiedRetriever } from '@/apis/retrievers';

export function useRetrievers(scope?: 'personal' | 'group' | 'all', groupName?: string) {
  const [retrievers, setRetrievers] = useState<UnifiedRetriever[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchRetrievers = useCallback(async () => {
    try {
      setLoading(true);
      const response = await retrieverApis.getUnifiedRetrievers(scope, groupName);
      setRetrievers(response.data || []);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, [scope, groupName]);

  useEffect(() => {
    fetchRetrievers();
  }, [fetchRetrievers]);

  return { retrievers, loading, error, refetch: fetchRetrievers };
}
