import { describe, expect, it } from "vitest";
import {
  compareIssueTimestamps,
  formatIssueTimestamp,
  issueExecutionElapsedMinutes,
} from "./issueTimestamp";

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
