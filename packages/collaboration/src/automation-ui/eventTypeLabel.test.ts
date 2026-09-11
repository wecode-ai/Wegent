import { describe, expect, test } from "vitest";
import { eventTypeLabel } from "./eventTypeLabel";

describe("eventTypeLabel", () => {
  test("maps known event types to their i18n keys", () => {
    const t = (key: string) => `[${key}]`;
    const cases: Array<[string, string]> = [
      ["task.created", "todo.event_type_task_created"],
      ["task.status_changed", "todo.event_type_task_status_changed"],
      ["change_request.checks_failed", "todo.event_type_checks_failed"],
      ["change_request.merge_conflict", "todo.event_type_merge_conflict"],
      ["change_request.review_submitted", "todo.event_type_review_submitted"],
      ["change_request.comment_created", "todo.event_type_comment_created"],
      ["change_request.merged", "todo.event_type_merged"],
      ["document.changed", "todo.event_type_document_changed"],
    ];
    cases.forEach(([eventType, key]) => {
      expect(eventTypeLabel(eventType, t)).toBe(`[${key}]`);
    });
  });

  test("falls back to the raw identifier for unknown types", () => {
    const t = (key: string) => `[${key}]`;
    expect(eventTypeLabel("unknown.event", t)).toBe("unknown.event");
  });
});
