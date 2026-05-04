import { invoke } from "@tauri-apps/api/core";

// 与 Rust DictationTestRequest（serde tag="vendor"）对齐。
export type DictationTestRequest =
  | {
      vendor: "tencent";
      appId: string;
      region?: string | null;
      secretId: string;
      secretKey: string;
      cosBucket?: string | null;
    }
  | {
      vendor: "aliyun";
      apiKey: string;
    };

export interface DictationTestResult {
  ok: boolean;
  /// 稳定错误码：ok / unauthenticated / network / missing_fields /
  ///            service_not_enabled / rate_limited / timeout / unknown /
  ///            cos_unauthorized / cos_not_found / oss_policy_failed
  code: string;
  message: string;
}

export async function testDictationProvider(
  req: DictationTestRequest,
): Promise<DictationTestResult> {
  return await invoke<DictationTestResult>("dictation_test_provider", { req });
}
