// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from "react";
import { MemberSearchPicker } from "../controls/MemberSearchPicker";
import { runActiveMemberSearch } from "../project-manage/memberSearch";
import type { CollaborationUser } from "../types";
import type { ProjectCreateLabels } from "./types";

export function ProjectPeoplePicker({
  labels,
  people,
  excludedIds,
  searchUsers,
  onSelect,
  directoryLoading = false,
  directoryError,
  onRetryDirectory,
}: {
  labels: ProjectCreateLabels;
  people: CollaborationUser[];
  excludedIds: number[];
  searchUsers?: (query: string) => Promise<CollaborationUser[]>;
  onSelect(user: CollaborationUser): void;
  directoryLoading?: boolean;
  directoryError?: string | null;
  onRetryDirectory?(): void;
}) {
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<{
    query: string;
    searchUsers: typeof searchUsers;
    users: CollaborationUser[];
    error?: string;
    attempt: number;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const current =
    response?.query === query &&
    response.searchUsers === searchUsers &&
    response.attempt === attempt;
  const results = current ? response.users : [];
  const error = directoryError || (current ? response.error : undefined);
  const loading = Boolean(query.trim() && searchUsers && !current);
  useEffect(() => {
    if (!query.trim() || !searchUsers) return;
    let active = true;
    const timer = window.setTimeout(() => {
      void runActiveMemberSearch({
        query: query.trim(),
        existingUserIds: new Set<number>(),
        search: async (value) => ({ users: await searchUsers(value) }),
        userId: (user) => user.id,
        isActive: () => active,
        onResults: (users) =>
          setResponse({ query, searchUsers, users, attempt }),
        onError: (cause) =>
          setResponse({
            query,
            searchUsers,
            users: [],
            attempt,
            error:
              cause instanceof Error && cause.message
                ? `${labels.peopleSearchFailed} ${cause.message}`
                : labels.peopleSearchFailed,
          }),
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [attempt, labels.peopleSearchFailed, query, searchUsers]);
  const candidates = (query.trim() && searchUsers ? results : people).filter(
    (user, index, all) =>
      !excludedIds.includes(user.id) &&
      all.findIndex((candidate) => candidate.id === user.id) === index,
  );
  return (
    <div>
      <small>{labels.availablePeople}</small>
      <MemberSearchPicker
        query={query}
        onQueryChange={setQuery}
        users={candidates}
        onSelect={onSelect}
        placeholder={labels.searchPeople}
        emptyLabel={labels.noAvailableCollaborators}
        addLabel={labels.addCollaborator}
        addingLabel={labels.addCollaborator}
        inputTestId="collaboration-project-create-people-search"
        resultTestId={(id) => "collaboration-project-create-member-" + id}
        loadingLabel={
          loading || directoryLoading ? labels.searchingPeople : undefined
        }
        error={error}
        searchable={Boolean(searchUsers)}
      >
        {error && (directoryError ? onRetryDirectory : searchUsers) ? (
          <button
            type="button"
            data-testid="collaboration-project-create-member-search-retry"
            onClick={() => {
              if (directoryError) onRetryDirectory?.();
              else setAttempt((value) => value + 1);
            }}
          >
            {labels.retry}
          </button>
        ) : null}
      </MemberSearchPicker>
    </div>
  );
}
