// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import { createProjectVersionMutationQueue } from "./projectMutationQueue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

describe("project version mutation queue", () => {
  it("serializes concurrent setting categories and passes the previous response version", async () => {
    const firstResponse = deferred<{ version: number }>();
    const update = vi
      .fn<(category: string, version: number) => Promise<{ version: number }>>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockResolvedValueOnce({ version: 7 });
    const queue = createProjectVersionMutationQueue<{ version: number }>(5);

    const visibility = queue.enqueue(
      (version) => update("visibility", version),
      (project) => project.version,
    );
    const display = queue.enqueue(
      (version) => update("card_display", version),
      (project) => project.version,
    );

    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenNthCalledWith(1, "visibility", 5);

    firstResponse.resolve({ version: 6 });
    await expect(visibility).resolves.toEqual({ version: 6 });
    await expect(display).resolves.toEqual({ version: 7 });

    expect(update).toHaveBeenNthCalledWith(2, "card_display", 6);
  });

  it("continues the queue after a failed mutation without inventing a version", async () => {
    const update = vi
      .fn<(version: number) => Promise<{ version: number }>>()
      .mockRejectedValueOnce(new Error("conflict"))
      .mockResolvedValueOnce({ version: 10 });
    const queue = createProjectVersionMutationQueue<{ version: number }>(9);

    await expect(
      queue.enqueue(update, (project) => project.version),
    ).rejects.toThrow("conflict");
    await expect(
      queue.enqueue(update, (project) => project.version),
    ).resolves.toEqual({ version: 10 });

    expect(update).toHaveBeenNthCalledWith(1, 9);
    expect(update).toHaveBeenNthCalledWith(2, 9);
  });
});
