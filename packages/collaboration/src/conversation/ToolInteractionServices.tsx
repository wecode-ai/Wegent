import { createContext, useContext, type ReactNode } from "react";
import type { RequestUserInputCardProps } from "./RequestUserInputCard";
import type { ToolBlock } from "./blocks/types";
import type { RuntimeTaskAddress } from "@wegent/chat-core/runtime";
export interface ToolInteractionServices {
  renderRequestUserInput?: (props: RequestUserInputCardProps) => ReactNode;
  requestUserInputSource?: RuntimeTaskAddress;
  renderMcpApp?: (block: ToolBlock, turnId?: string) => ReactNode;
  openProxySettings?: () => void;
  onOutputAction?: (action: "copy" | "open_file") => void;
  readImageFile?: (path: string) => Promise<Blob>;
}
const Context = createContext<ToolInteractionServices>({});
export function ToolInteractionServicesProvider({
  value,
  children,
}: {
  value: ToolInteractionServices;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useToolInteractionServices() {
  return useContext(Context);
}
