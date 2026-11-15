import { createContext, useContext } from "react";
import type { IssueResources } from "./issueResources";

export const IssueResourcesContext = createContext<IssueResources | undefined>(
  undefined,
);
export const useIssueResources = () => useContext(IssueResourcesContext);
