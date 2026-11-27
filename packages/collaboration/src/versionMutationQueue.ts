// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

export interface VersionMutationQueue<Project> {
  enqueue(
    mutation: (version: number) => Promise<Project>,
    readVersion: (project: Project) => number
  ): Promise<Project>
  synchronize(version: number): void
  getSnapshot(): number
  subscribe(listener: () => void, sourceVersion?: number): () => void
}

export function createVersionMutationQueue<Project>(
  initialVersion: number
): VersionMutationQueue<Project> {
  let version = initialVersion
  let tail = Promise.resolve()
  const listeners = new Set<() => void>()
  const synchronize = (nextVersion: number) => {
    const next = Math.max(version, nextVersion)
    if (Object.is(next, version)) return
    version = next
    listeners.forEach(listener => listener())
  }

  return {
    enqueue(mutation, readVersion) {
      const result = tail.then(async () => {
        const project = await mutation(version)
        synchronize(readVersion(project))
        return project
      })
      tail = result.then(
        () => undefined,
        () => undefined
      )
      return result
    },
    synchronize,
    getSnapshot: () => version,
    subscribe(listener, sourceVersion = version) {
      listeners.add(listener)
      synchronize(sourceVersion)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
