import { createContext, useContext, type ReactNode } from "react";
import type { ToolBlock } from "./blocks/types";
export interface ToolInteractionServices {
  renderMcpApp?: (block: ToolBlock) => ReactNode;
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
