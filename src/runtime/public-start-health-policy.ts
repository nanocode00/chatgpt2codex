/** The installed CLI keeps its external HTTPS start verification. Only the
 * isolated Tauri Preview may return after the owned Quick Tunnel URL and
 * localhost MCP are ready, while its existing native HTTPS probe continues
 * to report the public endpoint independently. */
export function deferPublicHealthOnStart(
  flags: Record<string, string | boolean>,
  instance: string,
  tunnelMode: string,
): boolean {
  const requested = flags["defer-public-health"];
  if (requested === undefined) return false;
  if (requested !== true || instance !== "tauri-preview-v1" || tunnelMode !== "cloudflare") {
    throw new Error("--defer-public-health requires the isolated Tauri Preview cloudflare start");
  }
  return true;
}

/** The preview must not await a slow/unreachable public endpoint. A null
 * result deliberately means "not yet verified", never "healthy". */
export async function publicHealthAtStart(
  tunnelMode: string,
  deferPublicHealth: boolean,
  publicUrl: string,
  probe: (url: string) => Promise<boolean>,
): Promise<boolean | null> {
  if (tunnelMode !== "cloudflare" || deferPublicHealth) return null;
  return probe(publicUrl);
}
