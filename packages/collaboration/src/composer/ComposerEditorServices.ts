import type { ComposerMentionIconResolver } from "./composerMentions";

export interface ComposerEditorServices {
  isWindowFocused: () => boolean;
  subscribeWindowFocus: (callback: (focused: boolean) => void) => () => void;
  preserveNativeEmptyCaret: boolean;
  resolveMentionIcon?: ComposerMentionIconResolver;
}

export const browserComposerEditorServices: ComposerEditorServices = {
  isWindowFocused: () => document.hasFocus(),
  subscribeWindowFocus(callback) {
    const onFocus = () => callback(true);
    const onBlur = () => callback(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  },
  preserveNativeEmptyCaret: true,
};
