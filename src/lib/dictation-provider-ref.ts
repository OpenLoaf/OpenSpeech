// 把当前 dictation settings 切片整成 Rust dispatch 需要的 ProviderRef DTO。
// Rust 侧定义见 src-tauri/src/asr/byok.rs。
//
// 仅传"非 secret"字段：appId / region 这种公开参数，加上 active provider 的
// id / vendor 引用。SecretId / SecretKey / ApiKey 留在 keyring 里，由 Rust
// 自己读，永远不通过 IPC 传输。

import type {
  DictationProviderMode,
  DictationVendor,
  DictationCustomProvider,
  DictationSettings,
} from "@/stores/settings";
import { useSettingsStore } from "@/stores/settings";

export interface ProviderRef {
  mode: DictationProviderMode;
  activeCustomProviderId: string | null;
  customProviderVendor: DictationVendor | null;
  customProviderName: string | null;
  tencentAppId: string | null;
  tencentRegion: string | null;
  tencentCosBucket: string | null;
}

function fromDictation(dictation: DictationSettings): ProviderRef {
  if (dictation.mode !== "custom") {
    return {
      mode: "saas",
      activeCustomProviderId: null,
      customProviderVendor: null,
      customProviderName: null,
      tencentAppId: null,
      tencentRegion: null,
      tencentCosBucket: null,
    };
  }
  const active: DictationCustomProvider | undefined = dictation.customProviders.find(
    (p) => p.id === dictation.activeCustomProviderId,
  );
  return {
    mode: "custom",
    activeCustomProviderId: active?.id ?? dictation.activeCustomProviderId ?? null,
    customProviderVendor: active?.vendor ?? null,
    customProviderName: active?.name ?? null,
    tencentAppId: active?.tencentAppId ?? null,
    tencentRegion: active?.tencentRegion ?? null,
    tencentCosBucket: active?.tencentCosBucket ?? null,
  };
}

/// 从 settings store 当前快照构造 ProviderRef，供 stt / transcribe 调用透传。
export function buildProviderRef(): ProviderRef {
  return fromDictation(useSettingsStore.getState().dictation);
}
