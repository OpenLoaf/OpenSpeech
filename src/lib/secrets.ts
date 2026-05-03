import { invoke } from "@tauri-apps/api/core";

// 机密走系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service）。
// 后端：src-tauri/src/secrets/mod.rs。**不要**把这些字段写入 tauri-plugin-store 或 localStorage。

export const SECRET_STT_API_KEY = "stt-api-key";
export const SECRET_AI_PROVIDER_KEY_PREFIX = "ai_provider_";

export async function setSecret(name: string, value: string): Promise<void> {
  await invoke("secret_set", { name, value });
}

export async function getSecret(name: string): Promise<string | null> {
  const v = await invoke<string | null>("secret_get", { name });
  return v ?? null;
}

export async function deleteSecret(name: string): Promise<void> {
  await invoke("secret_delete", { name });
}

const aiProviderKeyName = (id: string) => `${SECRET_AI_PROVIDER_KEY_PREFIX}${id}`;

export async function saveAiProviderKey(id: string, key: string): Promise<void> {
  await setSecret(aiProviderKeyName(id), key);
}

export async function loadAiProviderKey(id: string): Promise<string | null> {
  return await getSecret(aiProviderKeyName(id));
}

export async function deleteAiProviderKey(id: string): Promise<void> {
  await deleteSecret(aiProviderKeyName(id));
}
