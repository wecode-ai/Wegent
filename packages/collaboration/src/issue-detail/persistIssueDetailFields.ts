import type { CollaborationIssue } from "../types";
import { isIssueVersionConflict } from "./issueVersionConflict";
import type {
  SharedIssueDetailPort,
  SharedIssueDetailUpdateInput,
} from "./createSharedIssueDetailPort";

type IssueFields = Omit<SharedIssueDetailUpdateInput, "version">;

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export async function persistIssueDetailFields(
  source: CollaborationIssue,
  values: IssueFields,
  port: Pick<SharedIssueDetailPort["issues"], "get" | "update">,
): Promise<CollaborationIssue> {
  const fields = (Object.keys(values) as Array<keyof IssueFields>).filter(
    (key) => values[key] !== undefined && !equal(values[key], source[key]),
  );
  if (fields.length === 0) return source;
  const patch: IssueFields = Object.fromEntries(
    fields.map((key) => [key, values[key]]),
  );
  try {
    return await port.update(source.id, { version: source.version, ...patch });
  } catch (error) {
    if (!isIssueVersionConflict(error)) throw error;
    const latest = await port.get(source.id);
    if (
      fields.some(
        (key) =>
          !equal(latest[key], source[key]) && !equal(latest[key], values[key]),
      )
    ) {
      throw error;
    }
    return port.update(source.id, { version: latest.version, ...patch });
  }
}
