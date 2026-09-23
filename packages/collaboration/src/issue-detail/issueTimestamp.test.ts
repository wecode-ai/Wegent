import { describe, expect, it } from "vitest";
import { compareIssueTimestamps, formatIssueTimestamp } from "./issueTimestamp";

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
