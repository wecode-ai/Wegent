import { describe, expect, it } from "vitest";
import {
  compareIssueTimestamps,
  formatIssueTimestamp,
  issueExecutionElapsedMinutes,
  issueActivityTimestamp,
  issueThreadActivityTimestamp,
} from "./issueTimestamp";
import type { ProjectChatMessage } from "@wegent/chat-core";

describe("issueActivityTimestamp", () => {
  const message = {
    sender: { type: "agent" },
    metadata: { activity_at: "2026-10-10T08:10:03.456789+00:00" },
    createdAt: "2026-10-10T08:09:43Z",
    updatedAt: "2026-10-10T08:10:03Z",
  } as ProjectChatMessage;

  it("orders execution results after the status transition in the same second", () => {
    expect(
      compareIssueTimestamps(
        issueActivityTimestamp(message),
        "2026-10-10T08:10:03.123456Z",
      ),
    ).toBeGreaterThan(0);
  });

  it("uses the stored update time for messages without an activity timestamp", () => {
    expect(issueActivityTimestamp({ ...message, metadata: {} })).toBe(
      message.updatedAt,
    );
  });

  it("keeps user discussions at creation time when their content is updated", () => {
    expect(
      issueActivityTimestamp({
        ...message,
        sender: { type: "user", id: "1", name: "Ada" },
      }),
    ).toBe(message.createdAt);
  });

  it("uses the latest execution activity for a continued execution thread", () => {
    const continued = {
      ...message,
      metadata: { activity_at: "2026-10-10T08:12:03.456789Z" },
    };
    const userReply = {
      ...continued,
      sender: { type: "user" as const, id: "1", name: "Ada" },
      createdAt: "2026-10-10T08:13:00Z",
    };
    expect(
      issueThreadActivityTimestamp({
        root: message,
        replies: [userReply, continued],
      }),
    ).toBe(continued.metadata.activity_at);
    expect(
      issueThreadActivityTimestamp({ root: userReply, replies: [continued] }),
    ).toBe(userReply.createdAt);
  });
});

describe("formatIssueTimestamp", () => {
  it("treats timezone-less backend timestamps as UTC", () => {
    expect(formatIssueTimestamp("2026-09-22T06:31:00", "Asia/Shanghai")).toBe(
      "09-22 14:31",
    );
  });

  it("respects explicit timestamp offsets", () => {
    expect(
      formatIssueTimestamp("2026-09-22T14:31:00+08:00", "Asia/Shanghai"),
    ).toBe("09-22 14:31");
  });

  it("formats the same instant in the requested device timezone", () => {
    expect(
      formatIssueTimestamp("2026-09-22T06:31:00Z", "America/New_York"),
    ).toBe("09-22 02:31");
  });

  it("returns a stable fallback for invalid timestamps", () => {
    expect(formatIssueTimestamp("not-a-date", "Asia/Shanghai")).toBe("--");
  });

  it("sorts different timestamp representations by their actual instant", () => {
    const timestamps = [
      "2026-09-22T14:32:00+08:00",
      "2026-09-22T06:30:00",
      "2026-09-22T06:31:00Z",
    ];

    expect(timestamps.sort(compareIssueTimestamps)).toEqual([
      "2026-09-22T06:30:00",
      "2026-09-22T06:31:00Z",
      "2026-09-22T14:32:00+08:00",
    ]);
  });

  it("preserves backend submillisecond ordering across timezone representations", () => {
    expect(
      compareIssueTimestamps(
        "2026-10-10T08:10:03.123457Z",
        "2026-10-10T16:10:03.123456+08:00",
      ),
    ).toBeGreaterThan(0);
    expect(
      compareIssueTimestamps(
        "2026-10-10T08:10:03.1234",
        "2026-10-10T08:10:03.123400Z",
      ),
    ).toBe(0);
    expect(
      compareIssueTimestamps(
        "2026-10-10T08:10:03Z",
        "2026-10-10T08:10:03.000001Z",
      ),
    ).toBeLessThan(0);
  });
});

describe("issueExecutionElapsedMinutes", () => {
  const now = Date.parse("2026-10-08T12:35:00Z");

  it.each(["2026-10-08T12:27:24", "2026-10-08T20:27:24+08:00"])(
    "uses the same instant for running executions starting at %s",
    (started_at) => {
      expect(
        issueExecutionElapsedMinutes({ status: "running", started_at }, now),
      ).toBe(7);
    },
  );

  it.each(["succeeded", "failed", "cancelled"])(
    "stops accumulating time after a %s execution ends",
    (status) => {
      expect(
        issueExecutionElapsedMinutes(
          {
            status,
            started_at: "2026-10-08T12:27:24",
            completed_at: "2026-10-08T12:34:54",
          },
          now + 86_400_000,
        ),
      ).toBe(7);
    },
  );

  it("does not invent a start or completion time", () => {
    expect(issueExecutionElapsedMinutes({ status: "queued" }, now)).toBeNull();
    expect(
      issueExecutionElapsedMinutes(
        { status: "succeeded", started_at: "2026-10-08T12:27:24" },
        now,
      ),
    ).toBeNull();
    expect(issueExecutionElapsedMinutes(null, now)).toBeNull();
  });

  it("rejects invalid or reversed times instead of showing a false duration", () => {
    expect(
      issueExecutionElapsedMinutes({ started_at: "invalid" }, now),
    ).toBeNull();
    expect(
      issueExecutionElapsedMinutes({ started_at: "2026-10-08T12:36:00" }, now),
    ).toBeNull();
    expect(
      issueExecutionElapsedMinutes(
        { started_at: "2026-10-08T12:27:24", completed_at: "invalid" },
        now,
      ),
    ).toBeNull();
  });

  it("retains the one-minute minimum for an execution that just started", () => {
    expect(
      issueExecutionElapsedMinutes(
        { status: "running", started_at: "2026-10-08T12:34:59" },
        now,
      ),
    ).toBe(1);
  });
});
