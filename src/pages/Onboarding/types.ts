// Onboarding 3 步状态机定义。
// Step 1 = 系统权限授权 / Step 2 = 登录 / Step 3 = 试用一次。
// 早期还有一个 WELCOME 欢迎页，已删除——直接进权限授权页是最高效的路径。

export type OnboardingStep = 1 | 2 | 3;

export const STEP_TITLES: Record<OnboardingStep, string> = {
  1: "PERMISSIONS",
  2: "ACCOUNT",
  3: "TRY IT",
};

export type PermissionStatus = "idle" | "checking" | "granted" | "denied";
