// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { UserRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { runActiveMemberSearch } from "../project-manage/memberSearch";
import type { CollaborationUser, CollaborationWorkspaceMember } from "../types";
import type { ProjectCreateLabels, ProjectCreateResourceSetup } from "./types";

export function ProjectCreateMemberPicker({
  setup,
  selectedIds,
  labels,
  onSelect,
  onDiscovered,
}: {
  setup: ProjectCreateResourceSetup;
  selectedIds: number[];
  labels: ProjectCreateLabels;
  onSelect(userId: number): void;
  onDiscovered(users: CollaborationUser[]): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CollaborationUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const searchRef = useRef(setup.searchMembers);
  const discoveredRef = useRef(onDiscovered);
  searchRef.current = setup.searchMembers;
  discoveredRef.current = onDiscovered;
  const canSearch = Boolean(setup.searchMembers);
  useEffect(() => {
    const search = searchRef.current;
    setError(null);
    setLoading(false);
    if (!query.trim() || !search) {
      setResults([]);
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void runActiveMemberSearch({
        query: query.trim(),
        existingUserIds: new Set([setup.currentUser.id]),
        search: async (value) => ({ users: await search(value) }),
        userId: (user) => user.id,
        isActive: () => active,
        onResults: (users) => {
          setResults(users);
          discoveredRef.current(users);
        },
        onError: (cause) =>
          setError(
            cause instanceof Error && cause.message
              ? cause.message
              : labels.memberSearchFailed,
          ),
      }).finally(() => {
        if (active) setLoading(false);
      });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [
    canSearch,
    labels.memberSearchFailed,
    query,
    retry,
    setup.currentUser.id,
  ]);
  const directoryUsers = setup.members.map((member) => ({
    id: member.user_id,
    user_name: member.user_name,
    email: member.email,
  }));
  const users = (query.trim() && canSearch ? results : directoryUsers).filter(
    (user, index, list) =>
      user.id !== setup.currentUser.id &&
      list.findIndex((candidate) => candidate.id === user.id) === index &&
      (canSearch ||
        `${user.user_name} ${user.email ?? ""}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())),
  );
  const loadError = setup.membersError || error;
  return (
    <div>
      <small>{labels.availableMembers}</small>
      {canSearch || setup.members.length > 0 ? (
        <label className="collaboration-project-create-field">
          <span>{labels.searchMembers}</span>
          <input
            data-testid="collaboration-project-create-member-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.preventDefault();
            }}
            placeholder={labels.searchMembers}
          />
        </label>
      ) : null}
      {setup.membersLoading || loading ? (
        <p role="status">{labels.searchingMembers}</p>
      ) : null}
      {loadError ? (
        <div className="collaboration-project-create-error" role="alert">
          <p>{loadError}</p>
          {(setup.membersError && setup.reloadMembers) || error ? (
            <button
              type="button"
              data-testid="collaboration-project-create-member-search-retry"
              onClick={() => {
                if (setup.membersError) setup.reloadMembers?.();
                if (error) setRetry((value) => value + 1);
              }}
            >
              {labels.retry}
            </button>
          ) : null}
        </div>
      ) : null}
      {users.map((user) => (
        <button
          key={user.id}
          type="button"
          data-testid={`collaboration-project-create-member-${user.id}`}
          aria-pressed={selectedIds.includes(user.id)}
          onClick={() => onSelect(user.id)}
        >
          <UserRound aria-hidden="true" />
          <span>
            <strong>{user.user_name}</strong>
            <small>{user.email}</small>
          </span>
        </button>
      ))}
      {query.trim() && !loading && !loadError && users.length === 0 ? (
        <p data-testid="collaboration-project-create-no-matching-members">
          {labels.noMatchingMembers}
        </p>
      ) : null}
      {!canSearch &&
      setup.members.length === 0 &&
      !setup.membersLoading &&
      !setup.membersError &&
      setup.location === "local" ? (
        <p data-testid="collaboration-project-create-members-unavailable">
          {labels.membersUnavailable}
        </p>
      ) : null}
    </div>
  );
}

export function mergeProjectCreateMembers(
  directory: CollaborationWorkspaceMember[],
  discovered: CollaborationUser[],
): CollaborationWorkspaceMember[] {
  const members = new Map(directory.map((member) => [member.user_id, member]));
  for (const user of discovered) {
    if (!members.has(user.id)) {
      members.set(user.id, { ...user, user_id: user.id, role: "Developer" });
    }
  }
  return [...members.values()];
}

export function cacheDiscoveredMembers(
  current: CollaborationUser[],
  incoming: CollaborationUser[],
): CollaborationUser[] {
  if (
    !incoming.some((user) => {
      const known = current.find((candidate) => candidate.id === user.id);
      return (
        !known ||
        known.user_name !== user.user_name ||
        known.email !== user.email
      );
    })
  )
    return current;
  return [
    ...new Map(
      [...current, ...incoming].map((user) => [user.id, user]),
    ).values(),
  ];
}
