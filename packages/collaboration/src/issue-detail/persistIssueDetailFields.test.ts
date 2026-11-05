import { describe, expect, it, vi } from "vitest";
import type { CollaborationIssue } from "../types";
import { persistIssueDetailFields } from "./persistIssueDetailFields";

const issue = {
  id: "issue-1",
  version: 1,
  title: "Original",
  description: "",
  status: "in_progress",
  priority: "none",
  parent_id: null,
  due_at: null,
  tags: [],
} as CollaborationIssue;

function portFor(
  latest: CollaborationIssue,
  conflict: unknown = { code: "version_conflict" },
) {
  return {
    get: vi.fn().mockResolvedValue(latest),
    update: vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValue({
        ...latest,
        title: "Renamed",
        version: latest.version + 1,
      }),
  };
}

describe("persistIssueDetailFields", () => {
  it("saves only edited fields across a concurrent execution status change", async () => {
    const latest = {
      ...issue,
      status: "in_review",
      priority: "high",
      version: 2,
    } as CollaborationIssue;
    const port = portFor(latest);
    await expect(
      persistIssueDetailFields(
        issue,
        { title: "Renamed", status: issue.status, priority: issue.priority },
        port,
      ),
    ).resolves.toMatchObject({
      title: "Renamed",
      status: "in_review",
      priority: "high",
    });
    expect(port.update.mock.calls).toEqual([
      [issue.id, { version: 1, title: "Renamed" }],
      [issue.id, { version: 2, title: "Renamed" }],
    ]);
  });

  it.each([
    { code: "version_conflict" },
    {
      status: 409,
      detail: { code: "version_conflict", message: "TODO changed" },
    },
    { errorCode: "version_conflict" },
  ])("preserves a concurrent edit to the same field (%j)", async (conflict) => {
    const port = portFor(
      { ...issue, title: "Other editor", version: 2 },
      conflict,
    );
    await expect(
      persistIssueDetailFields(issue, { title: "Renamed" }, port),
    ).rejects.toBe(conflict);
    expect(port.get).toHaveBeenCalledWith(issue.id);
    expect(port.update).toHaveBeenCalledOnce();
  });

  it("does not recover an unrelated failure", async () => {
    const error = new Error("offline");
    const port = portFor(issue, error);
    await expect(
      persistIssueDetailFields(issue, { title: "Renamed" }, port),
    ).rejects.toBe(error);
    expect(port.get).not.toHaveBeenCalled();
    expect(port.update).toHaveBeenCalledOnce();
  });

  it("publishes the latest snapshot before rejecting a conflicting field", async () => {
    const latest = {
      ...issue,
      priority: "urgent",
      version: 2,
    } as CollaborationIssue;
    const port = portFor(latest);
    const onRefresh = vi.fn();
    await expect(
      persistIssueDetailFields(issue, { priority: "high" }, port, {
        onRefresh,
        isActive: () => true,
      }),
    ).rejects.toEqual({ code: "version_conflict" });
    expect(onRefresh).toHaveBeenCalledExactlyOnceWith(latest);
    expect(port.update).toHaveBeenCalledOnce();
  });

  it("does not refresh or retry a conflict after its scope has closed", async () => {
    const port = portFor({ ...issue, version: 2 });
    const onRefresh = vi.fn();
    await expect(
      persistIssueDetailFields(issue, { title: "Renamed" }, port, {
        onRefresh,
        isActive: () => false,
      }),
    ).rejects.toEqual({ code: "version_conflict" });
    expect(port.get).not.toHaveBeenCalled();
    expect(port.update).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not publish or retry when the scope closes during recovery", async () => {
    const port = portFor({ ...issue, version: 2 });
    let active = true;
    port.get.mockImplementation(async () => {
      active = false;
      return { ...issue, version: 2 };
    });
    const onRefresh = vi.fn();
    await expect(
      persistIssueDetailFields(issue, { title: "Renamed" }, port, {
        onRefresh,
        isActive: () => active,
      }),
    ).rejects.toEqual({ code: "version_conflict" });
    expect(port.update).toHaveBeenCalledOnce();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("does not classify a business denial as a version conflict", async () => {
    const error = { status: 409, detail: "This action is unavailable" };
    const port = portFor(issue, error);
    await expect(
      persistIssueDetailFields(issue, { status: "completed" }, port),
    ).rejects.toBe(error);
    expect(port.get).not.toHaveBeenCalled();
    expect(port.update).toHaveBeenCalledOnce();
  });

  it("stops if another version conflict arrives after rebasing", async () => {
    const port = portFor({ ...issue, version: 2 });
    const conflict = { code: "version_conflict" };
    port.update.mockReset().mockRejectedValue(conflict);
    await expect(
      persistIssueDetailFields(issue, { title: "Renamed" }, port),
    ).rejects.toBe(conflict);
    expect(port.update).toHaveBeenCalledTimes(2);
  });

  it("does not write unchanged fields or absent optional dates", async () => {
    const port = portFor(issue);
    await expect(
      persistIssueDetailFields(
        issue,
        { title: issue.title, start_at: null, tags: [] },
        port,
      ),
    ).resolves.toBe(issue);
    expect(port.update).not.toHaveBeenCalled();
  });
});
