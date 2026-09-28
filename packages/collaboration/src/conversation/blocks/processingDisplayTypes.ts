import type { SubagentBlock } from "./types";
import { type RequestUserInputBlock } from "@wegent/chat-core/runtime-user-input";
import { type ProcessingDisplayRow } from "./toolBlockActivity";

export type ProcessingDisplayItem =
  | ProcessingDisplayRow
  | {
      type: "subagent_group";
      id: string;
      blocks: SubagentBlock[];
    }
  | {
      type: "request_user_input";
      id: string;
      block: RequestUserInputBlock;
    };

export type ToolActivityLabels = {
  command: string;
  file: string;
  search: string;
  edit: string;
  other: string;
};
