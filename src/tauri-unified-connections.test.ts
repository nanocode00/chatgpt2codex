import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { publicView, runtimeView, startAction, storedPublicPreference } from "../desktop/src/dashboard-state";
import type { ManagedResult } from "../desktop/src/runtime";

const owned: ManagedResult = {
  available: true, ready: true, running: false, tunnelCapable: true,
  tunnelRunning: false, instance: "tauri-preview-v1", port: 18797, details: "ready"
};

describe("Tauri-owned connection and security screen", () => {
  it("separates offline desired public mode from the actual tunnel state", () => {
    expect(runtimeView(true, owned)).toBe("stopped");
    expect(startAction(storedPublicPreference("true"))).toBe("start-public");
    expect(startAction(storedPublicPreference(null))).toBe("start");
    expect(publicView(owned, null)).toBe("inactive");
    expect(publicView({ ...owned, running: true, tunnelRunning: false }, null)).toBe("inactive");
  });

  it("only considers an HTTPS probe for the matching Tauri-owned origin", () => {
    const exposed = { ...owned, running: true, tunnelRunning: true,
      publicConnector: "https://example.trycloudflare.com/mcp" };
    expect(publicView(exposed, null)).toBe("unchecked");
    expect(publicView(exposed, {
      state: "online", endpoint: "https://different.example.org/healthz", details: "ok"
    })).toBe("unchecked");
    expect(publicView(exposed, {
      state: "online", endpoint: "https://example.trycloudflare.com/healthz", details: "ok"
    })).toBe("online");
    expect(publicView(exposed, {
      state: "offline", endpoint: "https://example.trycloudflare.com/healthz", details: "failed"
    })).toBe("offline");
  });

  it("replaces the legacy default connection page with the owned native screen", () => {
    const source = readFileSync("desktop/src/App.tsx", "utf8");
    expect(source).toContain('screen === "connections" && <ConnectionsSecurityScreen');
    expect(source).toContain('publicHealth={ownedPublicHealth}');
    expect(source).toContain('ownerTokenPending={!!ownedToken}');
    expect(source).toContain('onTogglePublic={togglePublicPreference}');
    expect(source).toContain('onCopyToken={() => { void copyOwnedToken(); }}');
    expect(source).not.toContain("LegacyConnectionControls");
    expect(source).not.toContain('inspectInstalledCli("default")');
  });

  it("does not expose token text or pretend to change Cloudflare live", () => {
    const screen = readFileSync("desktop/src/ConnectionsSecurityScreen.tsx", "utf8");
    expect(screen).toContain('const canToggle = available && !runtimeBusy && owned?.tunnelCapable === true && !running');
    expect(screen).toContain('disabled={!canToggle}');
    expect(screen).toContain('aria-checked={running ? exposed : publicPreferred}');
    expect(screen).toContain('onManagedAction(startAction(publicPreferred))');
    expect(screen).toContain('onManagedAction("rotate-token")');
    expect(screen).toContain("ownerTokenPending");
    expect(screen).toContain("onCopyToken");
    expect(screen).not.toContain("value={ownedToken}");
    expect(screen).not.toContain("onManagedAction(\"start-public\")");
    expect(screen).toContain("OAuth 연결 승인");
    expect(screen).toContain("workspace_list_projects");
  });

  it("preserves a responsive neutral design and avoids inline copy-confirmation text", () => {
    const css = readFileSync("desktop/src/connections.css", "utf8");
    expect(css).toContain("container-type:inline-size");
    expect(css).toContain("@container connections");
    expect(css).toContain(".connections-button.primary");
    expect(css).toContain(".connections-switch:disabled");
    const screen = readFileSync("desktop/src/ConnectionsSecurityScreen.tsx", "utf8");
    expect(screen).toContain('onNotify("Tauri 전용 로컬 MCP 주소를 복사했습니다.")');
    expect(screen).not.toContain("복사 완료");
  });
});
