import { invoke } from "@tauri-apps/api/core";

export type CueKind = "start" | "stop" | "cancel";

export const cuePlay = async (kind: CueKind): Promise<void> => {
  try {
    await invoke("cue_play", { kind });
  } catch (e) {
    console.warn("[cue] play failed:", kind, e);
  }
};

export const cueSetEnabled = async (enabled: boolean): Promise<void> => {
  try {
    await invoke("cue_set_enabled", { enabled });
  } catch (e) {
    console.warn("[cue] set_enabled failed:", e);
  }
};

export const cueSetActive = async (active: boolean): Promise<void> => {
  try {
    await invoke("cue_set_active", { active });
  } catch (e) {
    console.warn("[cue] set_active failed:", e);
  }
};
