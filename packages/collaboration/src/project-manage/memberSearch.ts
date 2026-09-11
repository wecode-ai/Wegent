// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface ActiveMemberSearchOptions<User> {
  query: string;
  existingUserIds: ReadonlySet<number>;
  search(query: string): Promise<{ users: User[] }>;
  userId(user: User): number;
  isActive(): boolean;
  onResults(users: User[]): void;
  onError(cause: unknown): void;
}

export function clearMemberResultsForEmptyQuery<User>(
  query: string,
  onResults: (users: User[]) => void,
): boolean {
  if (query.trim()) return false;
  onResults([]);
  return true;
}

export async function runActiveMemberSearch<User>({
  query,
  existingUserIds,
  search,
  userId,
  isActive,
  onResults,
  onError,
}: ActiveMemberSearchOptions<User>): Promise<void> {
  try {
    const response = await search(query);
    if (!isActive()) return;
    onResults(
      response.users.filter((user) => !existingUserIds.has(userId(user))),
    );
  } catch (cause) {
    if (!isActive()) return;
    onResults([]);
    onError(cause);
  }
}
