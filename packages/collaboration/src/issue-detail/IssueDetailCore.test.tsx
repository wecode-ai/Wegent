// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import {
  IssueDetailAttachments,
  formatIssueAttachmentSize,
} from "./IssueDetailCore";
import {
  issueAssigneeTarget,
  parseIssueAssigneeTarget,
  persistIssueDetailDraft,
} from "./IssueDetailDraft";

describe("IssueDetailCore", () => {
  it("retains the local user with ID zero when opening an Issue", () => {
    expect(issueAssigneeTarget({ assignee_user_id: 0 })).toBe("user:0");
    expect(issueAssigneeTarget({ assignee_user_id: null })).toBe("");
    expect(parseIssueAssigneeTarget("user:0")).toEqual({
      assigneeUserId: 0,
      assigneeAgentId: null,
      assigneeTeamId: null,
    });
  });
  it("retains collaboration group ownership when opening an Issue", () => {
    expect(issueAssigneeTarget({ assignee_group_id: "squad-1" })).toBe(
      "group:squad-1",
    );
    expect(parseIssueAssigneeTarget("group:squad-1")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
      assigneeTeamId: null,
      assigneeGroupId: "squad-1",
    });
  });
  it("formats attachment sizes consistently for Web and Wework adapters", () => {
    expect(formatIssueAttachmentSize(512)).toBe("512 B");
    expect(formatIssueAttachmentSize(1536)).toBe("1.5 KB");
    expect(formatIssueAttachmentSize(2.5 * 1024 * 1024)).toBe("2.5 MB");
  });

  it("keeps a decoded attachment URL stable when the preview loader is recreated", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:attachment-preview");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: revokeObjectURL,
    });

    const labels = {
      title: "附件",
      upload: "上传",
      uploading: "上传中",
      empty: "暂无附件",
      dropzone: "拖放文件",
      downloading: "下载中",
      download: (name: string) => `下载 ${name}`,
      remove: (name: string) => `删除 ${name}`,
    };
    const renderAttachments = (loadPreview: (id: string) => Promise<Blob>) =>
      root.render(
        <IssueDetailAttachments
          attachments={[
            {
              id: "attachment-1",
              displayName: "image.png",
              contentType: "image/png",
              sizeBytes: 1,
            },
          ]}
          busy={false}
          error={null}
          editable={false}
          labels={labels}
          testIdPrefix="issue-attachment"
          onAdd={vi.fn(async () => undefined)}
          loadPreview={loadPreview}
          onRemove={vi.fn(async () => undefined)}
        />,
      );

    try {
      const firstLoad = vi.fn(
        async () => new Blob(["first"], { type: "image/png" }),
      );
      await act(async () => renderAttachments(firstLoad));
      await vi.waitFor(() => expect(firstLoad).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(
          container.querySelector<HTMLImageElement>(
            '[data-testid="issue-detail-attachment-thumbnail-attachment-1"]',
          )?.src,
        ).toBe("blob:attachment-preview"),
      );

      const recreatedLoad = vi.fn(
        async () => new Blob(["second"], { type: "image/png" }),
      );
      await act(async () => renderAttachments(recreatedLoad));
      expect(recreatedLoad).not.toHaveBeenCalled();
      expect(revokeObjectURL).not.toHaveBeenCalled();

      await act(async () => root.unmount());
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment-preview");
    } finally {
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: originalCreateObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: originalRevokeObjectURL,
      });
      container.remove();
    }
  });

  it("persists core fields before assigning against the returned version", async () => {
    const issue = { id: "issue-1", version: 1, assignee_user_id: null };
    const updated = { ...issue, version: 2 };
    const assigned = { ...updated, version: 3, assignee_user_id: 5 };
    const update = vi.fn(async () => updated);
    const assign = vi.fn(async () => assigned);

    await expect(
      persistIssueDetailDraft(
        issue,
        {
          title: "共享详情",
          description: "描述",
          status: "pending",
          priority: "high",
          parentId: "",
          dueDate: "",
          tags: [],
          assigneeTarget: "user:5",
          workflow: null,
        },
        false,
        {
          getAssigneeTarget: issueAssigneeTarget,
          update,
          assign,
        },
      ),
    ).resolves.toEqual(assigned);
    expect(update).toHaveBeenCalledWith(
      issue,
      expect.objectContaining({ title: "共享详情", assigneeTarget: "user:5" }),
      {
        assigneeUserId: 5,
        assigneeAgentId: null,
        assigneeTeamId: null,
      },
    );
    expect(assign).toHaveBeenCalledWith(updated, "user:5", false);
  });

  it("normalizes all supported assignee targets", () => {
    expect(parseIssueAssigneeTarget("agent:bot-1")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: "bot-1",
      assigneeTeamId: null,
    });
    expect(parseIssueAssigneeTarget("team:42")).toEqual({
      assigneeUserId: null,
      assigneeAgentId: null,
      assigneeTeamId: 42,
    });
  });
});
