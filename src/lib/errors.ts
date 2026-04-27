import i18n from "@/i18n";

const BACKEND_ERROR_MAP: Record<string, string> = {
  AUTH_LOGIN_TIMEOUT: "errors:auth.login_timeout",
  AUTH_INTERNAL: "errors:auth.internal",
  AUTH_NOT_AUTHENTICATED: "errors:auth.not_authenticated",
};

export function translateBackendError(code: string): string {
  const key = BACKEND_ERROR_MAP[code];
  return key ? i18n.t(key) : code;
}

export function isKnownBackendErrorCode(code: string): boolean {
  return code in BACKEND_ERROR_MAP;
}
