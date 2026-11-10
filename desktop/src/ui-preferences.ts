/** Frontend-only monitoring preferences. Never writes the owned CLI or WinForms runtime config. */
export const DEFAULT_HEALTH_PORT = 7979;

export function parseUiPort(value: string): number | null {
  if (!/^[1-9][0-9]{0,4}$/.test(value)) return null;
  const port = Number(value);
  return port <= 65535 ? port : null;
}

export function storedHealthPort(value: string | null): number {
  return value === null ? DEFAULT_HEALTH_PORT : parseUiPort(value) ?? DEFAULT_HEALTH_PORT;
}

export function storedAutoRefresh(value: string | null): boolean {
  return value !== "false";
}
