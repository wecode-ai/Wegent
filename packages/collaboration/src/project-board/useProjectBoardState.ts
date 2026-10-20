// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultProjectBoardSort,
  readProjectBoardColumnSorts,
  type ProjectBoardColumnSorts,
  type ProjectBoardSort,
} from "./projectBoardSorting";

export type ProjectBoardGroupBy = "status" | "priority" | "assignee" | "tag";

export interface ProjectBoardStateOptions {
  defaultGroupBy: ProjectBoardGroupBy;
  defaultSort?: ProjectBoardSort;
  focusStorageKey: string | null;
  personalGroupStorageKey: string | null;
  personalSortStorageKey?: string | null;
}

export function useProjectBoardState({
  defaultGroupBy,
  defaultSort = defaultProjectBoardSort,
  focusStorageKey,
  personalGroupStorageKey,
  personalSortStorageKey = null,
}: ProjectBoardStateOptions) {
  const [groupBy, setGroupBy] = useState<ProjectBoardGroupBy>("status");
  const [groupFilter, setGroupFilter] = useState("");
  const [query, setQuery] = useState("");
  const [columnSorts, setColumnSorts] = useState<ProjectBoardColumnSorts>({});
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
    setColumnSorts(
      readProjectBoardColumnSorts(
        personalSortStorageKey
          ? localStorage.getItem(personalSortStorageKey)
          : null,
      ),
    );
  }, [personalSortStorageKey]);

  const getColumnSort = useCallback(
    (columnKey: string): ProjectBoardSort =>
      columnSorts[JSON.stringify([groupBy, columnKey])] ?? defaultSort,
    [columnSorts, defaultSort, groupBy],
  );

  const selectColumnSort = useCallback(
    (columnKey: string, value: ProjectBoardSort) => {
      setColumnSorts((current) => {
        const next = {
          ...current,
          [JSON.stringify([groupBy, columnKey])]: value,
        };
        if (personalSortStorageKey)
          localStorage.setItem(personalSortStorageKey, JSON.stringify(next));
        return next;
      });
    },
    [groupBy, personalSortStorageKey],
  );

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
    getColumnSort,
    quickCreateStatus,
    scrollRef,
    selectGroupBy,
    selectColumnSort,
    setExternalGroupFilter,
    setExternalQuery,
    setGroupFilter,
    setQuery,
    setQuickCreateStatus,
    toggleFocusExecutionColumns,
  };
}
