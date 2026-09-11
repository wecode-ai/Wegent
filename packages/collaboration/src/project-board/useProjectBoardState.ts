// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

export type ProjectBoardGroupBy = "status" | "priority" | "assignee" | "tag";

export interface ProjectBoardStateOptions {
  defaultGroupBy: ProjectBoardGroupBy;
  focusStorageKey: string | null;
  personalGroupStorageKey: string | null;
}

export function useProjectBoardState({
  defaultGroupBy,
  focusStorageKey,
  personalGroupStorageKey,
}: ProjectBoardStateOptions) {
  const [groupBy, setGroupBy] = useState<ProjectBoardGroupBy>("status");
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");
  const [focusExecutionColumns, setFocusExecutionColumns] = useState(false);
  const [quickCreateStatus, setQuickCreateStatus] = useState<string | null>(
    null,
  );
  const [externalGroupFilter, setExternalGroupFilter] = useState("");
  const [externalQuery, setExternalQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const personalGroup = personalGroupStorageKey
      ? localStorage.getItem(personalGroupStorageKey)
      : null;
    setGroupBy(
      personalGroup === "status" ||
        personalGroup === "priority" ||
        personalGroup === "assignee" ||
        personalGroup === "tag"
        ? personalGroup
        : defaultGroupBy,
    );
    setGroupFilter("");
    setQuery("");
    setQuickCreateStatus(null);
  }, [defaultGroupBy, personalGroupStorageKey]);

  useEffect(() => {
    setFocusExecutionColumns(
      focusStorageKey
        ? localStorage.getItem(focusStorageKey) === "true"
        : false,
    );
  }, [focusStorageKey]);

  const selectGroupBy = useCallback(
    (nextGroupBy: ProjectBoardGroupBy) => {
      if (groupBy !== nextGroupBy && scrollRef.current) {
        scrollRef.current.scrollLeft = 0;
      }
      setGroupBy(nextGroupBy);
      setGroupFilter("");
      if (personalGroupStorageKey) {
        localStorage.setItem(personalGroupStorageKey, nextGroupBy);
      }
    },
    [groupBy, personalGroupStorageKey],
  );

  const toggleFocusExecutionColumns = useCallback(() => {
    setFocusExecutionColumns((current) => {
      const next = !current;
      if (focusStorageKey) {
        if (next) {
          localStorage.setItem(focusStorageKey, "true");
        } else {
          localStorage.removeItem(focusStorageKey);
        }
      }
      return next;
    });
  }, [focusStorageKey]);

  return {
    externalGroupFilter,
    externalQuery,
    focusExecutionColumns,
    groupBy,
    groupFilter,
    query,
    quickCreateStatus,
    scrollRef,
    selectGroupBy,
    setExternalGroupFilter,
    setExternalQuery,
    setGroupFilter,
    setQuery,
    setQuickCreateStatus,
    toggleFocusExecutionColumns,
  };
}
