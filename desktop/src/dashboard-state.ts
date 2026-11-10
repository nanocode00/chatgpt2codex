import type { ManagedResult, PublicTunnelHealth } from "./runtime";

export type RuntimeView = "unsupported" | "checking" | "unavailable" | "setup" | "stopped" | "online";
export type PublicView = "inactive" | "unchecked" | "online" | "offline" | "unavailable";

/** The dashboard must NEVER infer Tauri-owned status from the legacy 7979 health monitor. */
export function runtimeView(native: boolean, owned: ManagedResult | null): RuntimeView {
  if (!native) return "unsupported";
  if (!owned) return "checking";
  if (!owned.available) return "unavailable";
  if (!owned.ready) return "setup";
  return owned.running ? "online" : "stopped";
}

/** External HTTPS health is independent from the tunnel process being alive. */
export function publicView(owned: ManagedResult | null, checked: PublicTunnelHealth | null): PublicView {
  if (!owned?.running || !owned.tunnelRunning || !owned.publicConnector) return "inactive";
  if (!checked) return "unchecked";
  if (checked.state !== "online" && checked.state !== "offline") return "unavailable";
  // Don't reuse an HTTPS probe for a different Quick Tunnel URL.
  try {
    const connector = new URL(owned.publicConnector);
    const endpoint = checked.endpoint ? new URL(checked.endpoint) : null;
    if (!endpoint || connector.origin !== endpoint.origin || endpoint.protocol !== "https:") return "unchecked";
  } catch {
    return "unchecked";
  }
  return checked.state;
}
