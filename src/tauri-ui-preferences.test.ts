import { describe, expect, it } from "vitest";
import { DEFAULT_HEALTH_PORT, parseUiPort, storedAutoRefresh, storedHealthPort } from "../desktop/src/ui-preferences";

describe("isolated Tauri monitoring preferences", () => {
  it("defaults new installations to the Tauri-owned server", () => {
    expect(DEFAULT_HEALTH_PORT).toBe(18797);
  });
  it("round-trips a saved port and accepts only bounded decimal integers", () => {
    expect(parseUiPort("18797")).toBe(18797);
    expect(storedHealthPort("18797")).toBe(18797);
    for (const invalid of ["", " ", "0", "65536", "18797junk", "1e3", "-80", "8080.0", "999999"]) {
      expect(parseUiPort(invalid)).toBeNull();
      expect(storedHealthPort(invalid)).toBe(DEFAULT_HEALTH_PORT);
    }
    expect(storedHealthPort(null)).toBe(DEFAULT_HEALTH_PORT);
  });
  it("keeps auto refresh enabled unless explicitly disabled", () => {
    expect(storedAutoRefresh("false")).toBe(false);
    expect(storedAutoRefresh("true")).toBe(true);
    expect(storedAutoRefresh(null)).toBe(true);
    expect(storedAutoRefresh("corrupt")).toBe(true);
  });
});
