export type Platform = "macos" | "windows" | "linux";

let cached: Platform | null = null;

export function detectPlatform(): Platform {
  if (cached) return cached;
  const ua =
    typeof navigator !== "undefined" ? navigator.userAgent.toLowerCase() : "";
  if (ua.includes("mac")) cached = "macos";
  else if (ua.includes("win")) cached = "windows";
  else cached = "linux";
  return cached;
}
