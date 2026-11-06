// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface VersionMutationQueue<Project> {
  enqueue(
    mutation: (version: number) => Promise<Project>,
    readVersion: (project: Project) => number,
  ): Promise<Project>;
  synchronize(version: number): void;
}

export function createVersionMutationQueue<Project>(
  initialVersion: number,
): VersionMutationQueue<Project> {
  let version = initialVersion;
  let tail = Promise.resolve();

  return {
    enqueue(mutation, readVersion) {
      const result = tail.then(async () => {
        const project = await mutation(version);
        version = Math.max(version, readVersion(project));
        return project;
      });
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    synchronize(nextVersion) {
      version = Math.max(version, nextVersion);
    },
  };
}
