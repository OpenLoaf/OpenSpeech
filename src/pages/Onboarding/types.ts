// Onboarding 4 步状态机定义。
// 当前实现是纯 UI Mock：所有"授权 / 登录 / 录音"按钮只切本地状态，不接 Rust 业务。

export type OnboardingStep = 1 | 2 | 3 | 4;

export const STEP_TITLES: Record<OnboardingStep, string> = {
  1: "WELCOME",
  2: "PERMISSIONS",
  3: "ACCOUNT",
  4: "TRY IT",
};

export type PermissionStatus = "idle" | "checking" | "granted" | "denied";
