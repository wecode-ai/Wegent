// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import type {
  SharedWorkspaceProjectManagerApi,
  WorkspaceProjectManagerConfig,
  WorkspaceProjectManagerTrigger,
} from "../ports/SharedWorkspaceApi";

export function useProjectManagerAutomation(
  manager: SharedWorkspaceProjectManagerApi | undefined,
  projectId: string,
) {
  const [config, setConfig] = useState<WorkspaceProjectManagerConfig | null>(
    null,
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(Boolean(manager));

  useEffect(() => {
    let active = true;
    setConfig(null);
    setError("");
    setLoading(Boolean(manager));
    if (manager) {
      void manager
        .get(projectId)
        .then((nextConfig) => {
          if (active) setConfig(nextConfig);
        })
        .catch((cause) => {
          if (active) setError(String(cause));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }
    return () => {
      active = false;
    };
  }, [manager, projectId]);

  const saveTriggers = async (triggers: WorkspaceProjectManagerTrigger[]) => {
    if (!manager || !config) return false;
    setSaving(true);
    setError("");
    try {
      setConfig(await manager.save(projectId, { ...config, triggers }));
      return true;
    } catch (cause) {
      setError(String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return { config, error, loading, saving, saveTriggers };
}
