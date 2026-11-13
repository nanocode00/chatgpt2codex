/** The UI follows the actual Tauri-owned MCP port; only refresh cadence stays local. */
export const DEFAULT_HEALTH_PORT = 7979;

export function parseUiPort(value: string): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

export function storedAutoRefresh(value: string | null): boolean {
  return value !== "false";
}
