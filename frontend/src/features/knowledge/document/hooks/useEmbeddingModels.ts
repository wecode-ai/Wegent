// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState, useCallback } from 'react';
import { retrieverApis } from '@/apis/retrievers';
import { UnifiedModel } from '@/apis/models';

export function useEmbeddingModels() {
  const [models, setModels] = useState<UnifiedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchModels = useCallback(async () => {
    try {
      setLoading(true);
      const data = await retrieverApis.getEmbeddingModels();
      setModels(data);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  return { models, loading, error, refetch: fetchModels };
}
