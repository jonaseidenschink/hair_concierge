const LOCAL_ANALYTICS_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"])

export function shouldInitializeBrowserVendorAnalytics(
  hostname: string | null | undefined,
  localOverride = process.env.NEXT_PUBLIC_ENABLE_LOCAL_VENDOR_ANALYTICS === "true",
): boolean {
  if (!hostname) return true
  return localOverride || !LOCAL_ANALYTICS_HOSTNAMES.has(hostname.trim().toLowerCase())
}
