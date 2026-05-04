import { invoke } from "@tauri-apps/api/core";

// 机密走系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service）。
// 后端：src-tauri/src/secrets/mod.rs。**不要**把这些字段写入 tauri-plugin-store 或 localStorage。

export const SECRET_STT_API_KEY = "stt-api-key";
export const SECRET_AI_PROVIDER_KEY_PREFIX = "ai_provider_";
export const SECRET_DICTATION_PROVIDER_KEY_PREFIX = "dictation_provider_";

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

// ─── Dictation provider 凭证 ─────────────────────────────────────
//
// 单字段（阿里 DashScope ApiKey）和双字段（腾讯 SecretId + SecretKey）共用同一
// keyring 条目：内部统一存为 JSON 字符串，调用方根据 vendor 取/解。腾讯的 AppID
// 不是 secret，落 settings.json，不进 keyring。

const dictationProviderKeyName = (id: string) =>
  `${SECRET_DICTATION_PROVIDER_KEY_PREFIX}${id}`;

export interface AliyunDictationCredentials {
  apiKey: string;
}

export interface TencentDictationCredentials {
  secretId: string;
  secretKey: string;
}

export type DictationCredentials =
  | ({ vendor: "aliyun" } & AliyunDictationCredentials)
  | ({ vendor: "tencent" } & TencentDictationCredentials);

export async function saveDictationProviderCredentials(
  id: string,
  creds: DictationCredentials,
): Promise<void> {
  await setSecret(dictationProviderKeyName(id), JSON.stringify(creds));
}

export async function loadDictationProviderCredentials(
  id: string,
): Promise<DictationCredentials | null> {
  const raw = await getSecret(dictationProviderKeyName(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DictationCredentials>;
    if (parsed.vendor === "aliyun" && typeof parsed.apiKey === "string") {
      return { vendor: "aliyun", apiKey: parsed.apiKey };
    }
    if (
      parsed.vendor === "tencent" &&
      typeof parsed.secretId === "string" &&
      typeof parsed.secretKey === "string"
    ) {
      return {
        vendor: "tencent",
        secretId: parsed.secretId,
        secretKey: parsed.secretKey,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteDictationProviderKey(id: string): Promise<void> {
  await deleteSecret(dictationProviderKeyName(id));
}
