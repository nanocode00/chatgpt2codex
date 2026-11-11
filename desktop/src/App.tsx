import {
  Activity, ChevronRight, Code2,
  ExternalLink, FileText, FolderCode, HardDrive, Layers, LayoutDashboard, LockKeyhole, PlugZap,
  RefreshCcw, Settings2, ShieldCheck, TerminalSquare
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { checkRuntime, manageOwnedCli, copyOwnedOwnerToken, registerOwnedOwnerToken, inspectOwnedPublicTunnelHealth, inspectOwnedCatalog, unregisterOwnedRepository, pickOwnedRepositoryFolder, registerOwnedPickedRepository, cancelOwnedPickedRepository, closePreviewWindow, closePreviewWithOwnedMcp, hidePreviewWindow, isNativeApp, inspectPreviewAutostart, setPreviewAutostart, type PreviewStartupInspection, type ManagedAction, type ManagedResult, type CatalogInspection, type PickedRepositoryFolder, type PublicTunnelHealth, type RuntimeHealth } from "./runtime";
import { LegacySettingsControls } from "./LegacyControls";
import { DiagnosticsScreen } from "./DiagnosticsScreen";
import { ConnectionsSecurityScreen } from "./ConnectionsSecurityScreen";
import { OwnerTokenRotationDialog } from "./OwnerTokenRotationDialog";
import { CliParityPanel } from "./CliParityPanel";
import { Dashboard } from "./Dashboard";
import { ProjectsScreen } from "./ProjectsScreen";
import { ProfilesScreen } from "./ProfilesScreen";
import { JobsScreen } from "./JobsScreen";
import { Toast, type AppToast } from "./Toast";
import { storedPublicPreference } from "./dashboard-state";
import { parseUiPort, storedHealthPort, storedAutoRefresh } from "./ui-preferences";
import { MigrationPreflight } from "./MigrationPreflight";
import { inspectLegacyMigration, saveLegacySettingsSnapshot, inspectCredentialBackup, createCredentialBackup, rehearseCredentialRestore, type LegacyMigrationReport, type CredentialBackupReport, type RestoreRehearsalReport } from "./runtime";

type Screen = "overview" | "projects" | "profiles" | "connections" | "jobs" | "cli" | "diagnostics" | "settings";

/** Rust/Tauri invoke rejects with a plain string, not necessarily an Error. */
function nativeFailureMessage(error: unknown, fallback: string): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.trim() ? message.slice(0, 480) : fallback;
}

function loadPort(): number {
  try {
    return storedHealthPort(localStorage.getItem("c2c.desktop.health-port"));
  } catch {
    return 7979;
  }
}
function loadAutoRefresh(): boolean {
  try { return storedAutoRefresh(localStorage.getItem("c2c.desktop.autorefresh")); }
  catch { return true; }
}
function loadPublicPreference(): boolean {
  try { return storedPublicPreference(localStorage.getItem("c2c.desktop.public-preferred")); }
  catch { return false; }
}
const NAV: { name: Screen; label: string; icon: typeof LayoutDashboard }[] = [
  { name: "overview", label: "대시보드", icon: LayoutDashboard },
  { name: "projects", label: "프로젝트", icon: FolderCode },
  { name: "profiles", label: "실행 환경", icon: Layers },
  { name: "connections", label: "연결", icon: PlugZap },
  { name: "jobs", label: "작업", icon: FileText },
  { name: "cli", label: "CLI", icon: TerminalSquare },
  { name: "diagnostics", label: "진단·복구", icon: Activity },
  { name: "settings", label: "설정", icon: Settings2 }
];

function App() {
  const native = isNativeApp();
  const [screen, setScreen] = useState<Screen>("overview");
  const [jobsRefreshKey, setJobsRefreshKey] = useState(0);
  const [diagnosticsRefreshKey, setDiagnosticsRefreshKey] = useState(0);
  const [port, setPort] = useState(loadPort);
  const [draftPort, setDraftPort] = useState(String(loadPort()));
  const [autoRefresh, setAutoRefresh] = useState(loadAutoRefresh);
  const [publicPreferred, setPublicPreferred] = useState(loadPublicPreference);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [status, setStatus] = useState<RuntimeHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [exitError, setExitError] = useState("");
  const [exitBusy, setExitBusy] = useState(false);
  const [trayError, setTrayError] = useState("");
  const [owned, setOwned] = useState<ManagedResult | null>(null);
  const [ownedBusy, setOwnedBusy] = useState(false);
  const [ownedError, setOwnedError] = useState("");
  const [ownedToken, setOwnedToken] = useState<string | null>(null);
  const [rotationDialogOpen, setRotationDialogOpen] = useState(false);
  const [ownedPublicHealth, setOwnedPublicHealth] = useState<PublicTunnelHealth | null>(null);
  const [ownedPublicChecking, setOwnedPublicChecking] = useState(false);
  const [catalog, setCatalog] = useState<CatalogInspection | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [pickedFolder, setPickedFolder] = useState<PickedRepositoryFolder | null>(null);
  const [folderName, setFolderName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderError, setFolderError] = useState("");
  const [folderNotice, setFolderNotice] = useState("");
  const [unregisterTarget, setUnregisterTarget] = useState<string | null>(null);
  const [unregisterTyped, setUnregisterTyped] = useState("");
  const [unregisterBusy, setUnregisterBusy] = useState(false);
  const [unregisterError, setUnregisterError] = useState("");
  const [unregisterNotice, setUnregisterNotice] = useState("");
  const [migrationReport, setMigrationReport] = useState<LegacyMigrationReport | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const [credentialBackup, setCredentialBackup] = useState<CredentialBackupReport | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupError, setBackupError] = useState("");
  const [rehearsal, setRehearsal] = useState<RestoreRehearsalReport | null>(null);
  const [rehearsalBusy, setRehearsalBusy] = useState(false);
  const [rehearsalError, setRehearsalError] = useState("");
  const [settingError, setSettingError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [previewStartup, setPreviewStartup] = useState<PreviewStartupInspection | null>(null);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState("");
  const requestCounter = useRef(0);
  const publicProbeBusy = useRef(false);
  const toastId = useRef(0);
  const notify = useCallback((message: string, tone: "info" | "error" = "info") => {
    setToast({ id: ++toastId.current, message, tone });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const runCheck = useCallback(async () => {
    const current = ++requestCounter.current;
    setChecking(true);
    try {
      const next = await checkRuntime(port);
      if (current !== requestCounter.current) return;
      setStatus(next);
    } catch (error) {
      if (current !== requestCounter.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      setStatus({ online: false, port, service: "ChatGPT To Codex",
        endpoint: "http://127.0.0.1:" + port + "/mcp",
        details: "검사 실패: " + detail });
    } finally {
      if (current === requestCounter.current) setChecking(false);
    }
  }, [port]);

  useEffect(() => { void runCheck(); return () => { requestCounter.current += 1; }; }, [runCheck]);
  useEffect(() => {
    if (!native) return;
    void inspectPreviewAutostart().then(setPreviewStartup).catch(() => {
      setStartupError("자동 시작 등록 상태를 확인할 수 없습니다.");
    });
  }, [native]);
  const togglePreviewStartup = async (enable: boolean) => {
    if (!previewStartup?.supported || startupBusy) return;
    setStartupError("");
    setStartupBusy(true);
    try {
      setPreviewStartup(await setPreviewAutostart(enable));
    } catch (error) {
      setStartupError(error instanceof Error ? error.message : String(error));
      try { setPreviewStartup(await inspectPreviewAutostart()); } catch { /* preserve error */ }
    } finally {
      setStartupBusy(false);
    }
  };
  useEffect(() => {
    if (!autoRefresh || !native) return;
    const interval = setInterval(() => { void runCheck(); }, 10_000);
    return () => clearInterval(interval);
  }, [autoRefresh, native, runCheck]);


  const runOwnedAction = useCallback(async (action: ManagedAction, confirmedRotation = false) => {
    if (action === "start-public" && !window.confirm(
      "Tauri 전용 MCP를 Cloudflare Quick Tunnel로 외부에 공개할까요?\n\n별도 18797 인스턴스만 사용하며 기존 WinForms/7979는 변경하지 않습니다. 공개 주소는 재시작 때 변경될 수 있고, 연결에는 인증 승인이 필요합니다."
    )) return;
    if (action === "rotate-token") {
      if (!confirmedRotation) {
        setOwnedError("");
        setRotationDialogOpen(true);
        return;
      }
      // Only the app's typed-acknowledgement dialog passes confirmedRotation.
      // Native Rust independently enforces fully stopped instance ownership.
      setOwnedToken(null);
      setOwnedPublicHealth(null);
    }
    setOwnedBusy(true);
    setOwnedError("");
    try {
      const next = await manageOwnedCli(action);
      setOwnedPublicHealth(previous =>
        previous?.endpoint && previous.endpoint === next.publicConnector ? previous : null);
      if (next.oneTimeOwnerToken) {
        setOwnedToken(next.oneTimeOwnerToken);
        setOwned({ ...next, oneTimeOwnerToken: undefined });
      } else {
        setOwned(next);
      }
      if (action === "rotate-token") setRotationDialogOpen(false);
      if (action !== "status") {
        const labels: Record<ManagedAction, string> = {
          status: "상태 조회", prepare: "MCP 준비", "rotate-token": "토큰 재발급",
          start: "MCP 시작", "start-public": "MCP 및 공개 연결 시작",
          stop: "MCP 중지", restart: "MCP 재시작"
        };
        notify(labels[action] + " 완료");
      }
    } catch (error) {
      const message = nativeFailureMessage(error, "전용 CLI 작업에 실패했습니다.");
      setOwnedError(message);
      notify(message, "error");
    } finally {
      setOwnedBusy(false);
    }
  }, [notify]);

  const refreshCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogError("");
    try {
      const updated = await inspectOwnedCatalog();
      setCatalog(updated);
    } catch (error) {
      setCatalog(null);
      setCatalogError(error instanceof Error ? error.message : "프로젝트/프로필 조회에 실패했습니다.");
    } finally {
      setCatalogBusy(false);
    }
  }, []);

  useEffect(() => {
    if (screen === "connections" || screen === "overview" || screen === "projects" || screen === "profiles") {
      void runOwnedAction("status");
      void refreshCatalog();
    }
  }, [screen, runOwnedAction, refreshCatalog]);

  async function browseOwnedFolder() {
    if (owned?.running || ownedBusy || folderBusy || unregisterBusy || unregisterTarget !== null) return;
    setFolderBusy(true);
    setFolderError("");
    setFolderNotice("");
    try {
      const picked = await pickOwnedRepositoryFolder();
      setPickedFolder(picked);
      setFolderName(picked?.suggestedName ?? "");
      setFolderId(picked?.suggestedId ?? "");
    } catch (error) {
      setPickedFolder(null);
      setFolderError(nativeFailureMessage(error, "폴더 선택에 실패했습니다."));
    } finally {
      setFolderBusy(false);
    }
  }

  async function discardOwnedFolder() {
    const choice = pickedFolder;
    setPickedFolder(null);
    setFolderError("");
    if (!choice) return;
    try {
      await cancelOwnedPickedRepository(choice.serial);
    } catch (error) {
      setFolderError(nativeFailureMessage(error, "선택 취소에 실패했습니다."));
    }
  }

  async function registerOwnedFolder() {
    const choice = pickedFolder;
    const name = folderName.trim();
    const id = folderId.trim();
    if (!choice || !catalog?.available || owned?.running || ownedBusy || folderBusy ||
        unregisterBusy || unregisterTarget !== null) return;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id.includes("..")) {
      setFolderError("프로젝트 ID는 영문 소문자·숫자로 시작하며 최대 64자여야 합니다.");
      return;
    }
    if (!name || name.length > 160 || name.startsWith("-")) {
      setFolderError("프로젝트 이름은 1~160자이며 '-'로 시작할 수 없습니다.");
      return;
    }
    if (!window.confirm(
      `다음 폴더를 Tauri 전용 프로젝트로 등록할까요?\n\n경로: ${choice.path}\n이름: ${name}\nID: ${id}\n\n기존 WinForms/7979는 변경되지 않으며 등록만 하고 서버를 시작하지 않습니다.`
    )) return;
    setFolderBusy(true);
    setFolderError("");
    setFolderNotice("");
    try {
      await registerOwnedPickedRepository(choice.serial, id, name);
      setPickedFolder(null);
      await refreshCatalog();
      setFolderNotice(`"${name}"(${id}) 프로젝트를 Tauri 전용 목록에 등록했습니다. 이제 ChatGPT에서 projectId로 사용할 수 있습니다.`);
      notify(`프로젝트 "${name}" 등록 완료`);
    } catch (error) {
      setFolderError(nativeFailureMessage(error, "프로젝트 등록에 실패했습니다."));
      await refreshCatalog();
    } finally {
      setFolderBusy(false);
    }
  }

  function requestUnregister(id: string) {
    if (unregisterBusy || folderBusy || ownedBusy || catalogBusy || owned?.running ||
        !catalog?.available || !catalog.projects.some(item => item.id === id)) return;
    setUnregisterTarget(id);
    setUnregisterTyped("");
    setUnregisterError("");
    setUnregisterNotice("");
  }

  function cancelUnregister() {
    if (unregisterBusy) return;
    setUnregisterTarget(null);
    setUnregisterTyped("");
    setUnregisterError("");
  }

  async function confirmUnregister() {
    const id = unregisterTarget;
    if (!id || unregisterTyped !== id || unregisterBusy || folderBusy ||
        catalogBusy || ownedBusy || owned?.running || !catalog?.available ||
        !catalog.projects.some(item => item.id === id)) return;
    setUnregisterBusy(true);
    setUnregisterError("");
    setUnregisterNotice("");
    try {
      await unregisterOwnedRepository(id);
      setUnregisterTarget(null);
      setUnregisterTyped("");
      await refreshCatalog();
      setUnregisterNotice(`"${id}"의 Tauri 전용 등록을 해제했습니다. 실제 프로젝트 폴더와 파일은 삭제하지 않았습니다.`);
      notify(`프로젝트 "${id}" 등록 해제 완료 · 실제 폴더는 유지됩니다.`);
    } catch (error) {
      setUnregisterError(nativeFailureMessage(error, "프로젝트 등록 해제에 실패했습니다."));
      await refreshCatalog();
    } finally {
      setUnregisterBusy(false);
    }
  }

  const checkOwnedPublicHealth = useCallback(async () => {
    if (publicProbeBusy.current) return;
    publicProbeBusy.current = true;
    setOwnedPublicChecking(true);
    try {
      setOwnedPublicHealth(await inspectOwnedPublicTunnelHealth());
    } catch (error) {
      setOwnedPublicHealth({ state: "unavailable", endpoint: null,
        details: nativeFailureMessage(error, "Tauri 전용 외부 연결 확인에 실패했습니다.") });
    } finally {
      publicProbeBusy.current = false;
      setOwnedPublicChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!native || !owned?.running || !owned.tunnelRunning || !owned.publicConnector) {
      setOwnedPublicHealth(null);
      return;
    }
    void checkOwnedPublicHealth();
    const timer = window.setInterval(() => { void checkOwnedPublicHealth(); }, 30_000);
    const onResume = () => { void checkOwnedPublicHealth(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
    };
  }, [native, owned?.running, owned?.tunnelRunning, owned?.publicConnector, checkOwnedPublicHealth]);

  function togglePublicPreference(enable: boolean) {
    if (owned?.running) {
      notify("실행 중 터널 변경에는 OAuth 주소 갱신이 필요합니다. 안전한 연결·해제 기능을 구현한 뒤 사용할 수 있습니다.", "error");
      return; // Never claim a tunnel mode changed when the runtime did not change.
    }
    if (!native || !owned?.available || !owned.tunnelCapable || ownedBusy) return;
    try {
      localStorage.setItem("c2c.desktop.public-preferred", String(enable));
      setPublicPreferred(enable);
      notify(enable ? "외부 공개를 다음 MCP 시작에 적용하도록 저장했습니다." : "다음 MCP 시작은 로컬 전용으로 설정했습니다.");
    } catch {
      notify("외부 공개 설정을 저장하지 못했습니다. 변경사항은 적용되지 않았습니다.", "error");
    }
  }

  async function copyOwnedConnector() {
    if (!owned?.tunnelRunning || !owned.publicConnector) return;
    try {
      await navigator.clipboard.writeText(owned.publicConnector);
        notify("공개 MCP 주소를 복사했습니다. 연결은 OAuth 인증 후 확인하세요.");
    } catch {
      notify("공개 주소를 복사하지 못했습니다. 직접 선택해 복사하세요.", "error");
    }
  }

  async function copyOwnedToken() {
    if (!ownedToken) return;
    try {
      await navigator.clipboard.writeText(ownedToken);
      setOwnedToken(null);
      notify("새 Owner Token을 복사하고 앱의 일회성 값을 지웠습니다.");
    } catch {
      const message = "클립보드 복사에 실패했습니다. 일회성 토큰은 지워지지 않았습니다.";
      setOwnedError(message);
      notify(message, "error");
    }
  }

  const runMigrationCheck = useCallback(async (snapshot = false) => {
    if (!native) return;
    setMigrationBusy(true);
    setMigrationError("");
    try {
      const report = snapshot ? await saveLegacySettingsSnapshot() : await inspectLegacyMigration();
      setMigrationReport(report);
    } catch (error) {
      setMigrationError(error instanceof Error ? error.message : "이전 환경 점검에 실패했습니다.");
    } finally {
      setMigrationBusy(false);
    }
  }, [native]);

  const runBackupCheck = useCallback(async (create = false) => {
    if (!native) return;
    if (create && !window.confirm("기존 OAuth 및 Owner Token 해시를 현재 Windows 사용자 계정 전용 DPAPI 백업에 암호화해 저장할까요? 원본은 수정하지 않으며 복구는 아직 지원하지 않습니다.")) return;
    setBackupBusy(true);
    setBackupError("");
    try {
      setCredentialBackup(create ? await createCredentialBackup() : await inspectCredentialBackup());
    } catch (error) {
      setBackupError(error instanceof Error ? error.message : "암호화 백업 확인에 실패했습니다.");
    } finally {
      setBackupBusy(false);
    }
  }, [native]);

  const runRestoreRehearsal = useCallback(async () => {
    if (!native) return;
    if (!window.confirm("암호화 백업을 별도 임시 폴더에서 복원·검증할까요? 평문 인증 파일은 저장하지 않으며 WinForms와 현재 MCP 서버는 그대로 둡니다.")) return;
    setRehearsalBusy(true);
    setRehearsalError("");
    setRehearsal(null);
    try {
      setRehearsal(await rehearseCredentialRestore());
    } catch (error) {
      setRehearsalError(error instanceof Error ? error.message : "격리 복원 리허설에 실패했습니다.");
    } finally {
      setRehearsalBusy(false);
    }
  }, [native]);

  useEffect(() => {
    if (screen === "settings" && native) {
      void runMigrationCheck();
      void runBackupCheck();
    }
  }, [screen, native, runMigrationCheck, runBackupCheck]);

  async function exitPreview(includeOwnedMcp = false) {
    if (exitBusy || ownedBusy) return;
    if (includeOwnedMcp && !window.confirm(
      "Tauri 전용 MCP 서버와 Quick Tunnel을 안전하게 중지하고 앱을 종료할까요?\\n\\n현재 ChatGPT의 작업 연결은 끊어집니다. 기존 WinForms/7979 서버는 유지됩니다. 서버 중지에 실패하면 앱을 종료하지 않습니다."
    )) return;
    setExitBusy(true);
    setExitError("");
    try {
      if (includeOwnedMcp) await closePreviewWithOwnedMcp();
      else await closePreviewWindow();
    } catch (error) {
      setExitError(nativeFailureMessage(error,
        includeOwnedMcp
          ? "전용 MCP 종료에 실패했습니다. 앱을 유지하고 상태를 확인하세요."
          : "Tauri 앱 종료에 실패했습니다."));
    } finally {
      setExitBusy(false);
    }
  }

  async function hideToTray() {
    setTrayError("");
    try {
      await hidePreviewWindow();
    } catch (error) {
      setTrayError(error instanceof Error ? error.message : String(error));
    }
  }

  function saveSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = parseUiPort(draftPort);
    if (next === null) {
      setSettingError("포트는 1부터 65535까지의 정수여야 합니다.");
      setSettingsNotice("");
      return;
    }
    try {
      localStorage.setItem("c2c.desktop.health-port", String(next));
    } catch {
      setSettingError("모니터링 포트를 저장하지 못했습니다. 저장소 권한을 확인하세요.");
      setSettingsNotice("");
      return;
    }
    setSettingError("");
    setSettingsNotice("로컬 상태 검사 대상 포트만 변경했습니다. 실제 C2C 서버 설정은 그대로입니다.");
    setPort(next);
  }

  function toggleAutoRefresh(next: boolean) {
    try {
      localStorage.setItem("c2c.desktop.autorefresh", String(next));
    } catch {
      setSettingError("자동 확인 설정을 저장하지 못했습니다. 변경사항은 적용하지 않았습니다.");
      return;
    }
    setSettingError("");
    setAutoRefresh(next);
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Code2 size={19} strokeWidth={2.2} /></div><div><strong>Codex</strong><span>to ChatGPT · Desktop</span></div></div>
        <div className="nav-section-title">WORKSPACE</div>
        <nav aria-label="메뉴">
          {NAV.map(item => {
            const Icon = item.icon;
            return <button key={item.name} type="button" className={"nav-item " + (screen === item.name ? "active" : "")} aria-current={screen === item.name ? "page" : undefined} onClick={() => setScreen(item.name)}><Icon size={18} strokeWidth={1.8} /><span>{item.label}</span>{screen === item.name && <ChevronRight size={14} className="nav-tail" />}</button>;
          })}
        </nav>
        <div className="sidebar-divider" />
        <div className="nav-section-title">RUNTIME</div>
        <button type="button" className="mini-runtime" onClick={() => setScreen("connections")}>
          <HardDrive size={17} />
          <span><strong>Tauri 전용 MCP</strong><small>127.0.0.1:18797</small></span>
          <span className={"tiny-led " + (owned?.running ? "glow" : "")} />
        </button>
        <div className="sidebar-bottom">
          <div className="mini-security"><ShieldCheck size={16} /><span>독립 Tauri · 전환 준비 중</span></div>
          <div className="sidebar-version">Preview 0.1 · Tauri 2</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>ChatGPT To Codex</span><ChevronRight size={15}/><strong>{NAV.find(n => n.name === screen)?.label}</strong></div>
          <div className="header-actions">
            <span className="host-indicator"><span className={"host-dot " + (native ? "connected" : "")} />{native ? "이 컴퓨터" : "웹 미리보기"}</span>
            <button className={"icon-btn " + (checking ? "spin-icon" : "")} type="button" onClick={() => {
                if (screen === "jobs") {
                  setJobsRefreshKey(value => value + 1);
                } else if (screen === "diagnostics") {
                  setDiagnosticsRefreshKey(value => value + 1);
                } else if (screen === "overview" || screen === "projects" || screen === "connections") {
                  void runOwnedAction("status"); void refreshCatalog();
                } else { void runCheck(); }
              }} aria-label="현재 화면 새로고침" title="현재 화면 새로고침" disabled={checking || ownedBusy || catalogBusy}><RefreshCcw size={17}/></button>
          </div>
        </header>

        <div className="page-scroll">
        <div className="page-content">
        {screen === "overview" && <Dashboard
          native={native}
          owned={owned} ownedBusy={ownedBusy} ownedError={ownedError}
          ownedPublicHealth={ownedPublicHealth} ownedPublicChecking={ownedPublicChecking}
          publicPreferred={publicPreferred}
          catalog={catalog} catalogBusy={catalogBusy} catalogError={catalogError}
          onRefreshOwned={() => { void runOwnedAction("status"); }}
          onRefreshCatalog={() => { void refreshCatalog(); }}
          onOwnedAction={action => { void runOwnedAction(action); }}
          onTogglePublic={togglePublicPreference}
          onCopyPublic={() => { void copyOwnedConnector(); }}
          onNotify={notify}
          onNavigate={to => setScreen(to === "manage" ? "connections" : to)}
        />}

        {screen === "projects" && <ProjectsScreen
          catalog={catalog} catalogBusy={catalogBusy} catalogError={catalogError}
          ownedRunning={owned?.running === true} ownedBusy={ownedBusy}
          pickedFolder={pickedFolder} folderBusy={folderBusy}
          folderName={folderName} folderId={folderId} folderError={folderError}
          unregisterTarget={unregisterTarget} unregisterTyped={unregisterTyped}
          unregisterBusy={unregisterBusy} unregisterError={unregisterError}
          onRefresh={() => { void refreshCatalog(); }}
          onBrowse={() => { void browseOwnedFolder(); }}
          onCancelBrowse={() => { void discardOwnedFolder(); }}
          onFolderName={setFolderName} onFolderId={setFolderId}
          onRegister={() => { void registerOwnedFolder(); }}
          onRequestUnregister={requestUnregister} onCancelUnregister={cancelUnregister}
          onUnregisterTyped={setUnregisterTyped}
          onConfirmUnregister={() => { void confirmUnregister(); }}
          onNotify={notify}
          onManageRuntime={() => setScreen("connections")}
        />}

        {screen === "profiles" && <ProfilesScreen
          catalog={catalog} catalogBusy={catalogBusy} catalogError={catalogError}
          onRefresh={refreshCatalog} onNotify={notify}
        />}

        {screen === "jobs" && <JobsScreen onNotify={notify}
          refreshKey={jobsRefreshKey} onProjects={() => setScreen("projects")}
        />}

        {screen === "cli" && <>
          <div className="page-heading"><div><div className="eyebrow">CLI PARITY</div><h1>고급 CLI</h1><p>실행 환경은 전용 화면에서 관리합니다. 이곳에서는 설정·진단·고급 조회만 제공합니다.</p></div></div>
          <CliParityPanel />
        </>}

        {screen === "connections" && <ConnectionsSecurityScreen
          native={native} owned={owned} ownedBusy={ownedBusy} ownedError={ownedError}
          ownerTokenPending={!!ownedToken}
          tokenCopyAvailable={owned?.tokenCopyAvailable === true} publicPreferred={publicPreferred}
          publicHealth={ownedPublicHealth} publicChecking={ownedPublicChecking}
          onRefresh={() => { void runOwnedAction("status"); }}
          onManagedAction={action => { void runOwnedAction(action); }}
          onTogglePublic={togglePublicPreference}
          onCopyPublic={() => { void copyOwnedConnector(); }}
          onCopyToken={() => { void copyOwnedToken(); }}
          onCopyStoredToken={async () => { await copyOwnedOwnerToken(); setOwnedToken(null); }}
          onRegisterToken={async (candidate) => {
            await registerOwnedOwnerToken(candidate);
            await runOwnedAction("status");
          }}
          onNotify={notify}
          onDiagnostics={() => setScreen("diagnostics")}
        />}

        {screen === "diagnostics" && <DiagnosticsScreen
          native={native} owned={owned} ownedBusy={ownedBusy} ownedError={ownedError}
          publicHealth={ownedPublicHealth} publicChecking={ownedPublicChecking}
          refreshKey={diagnosticsRefreshKey}
          onRefreshOwned={() => { void runOwnedAction("status"); }}
          onRefreshPublic={() => { void checkOwnedPublicHealth(); }}
          onConnections={() => setScreen("connections")}
          onNotify={notify}
        />}

        {screen === "settings" && <>
          <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>모니터링과 별도 Tauri 자동 시작 상태를 관리합니다. 기존 C2C CLI 설정은 변경하지 않습니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Settings2 size={18}/></span><div><h2>모니터링</h2><p>조회 대상과 갱신 주기를 관리합니다.</p></div></div></div><form onSubmit={saveSettings} className="settings-form"><label htmlFor="port-setting">로컬 MCP 포트</label><p>상태 확인 요청을 보낼 localhost 포트입니다.</p><div className="setting-control"><input id="port-setting" type="number" min="1" max="65535" value={draftPort} onChange={event => setDraftPort(event.target.value)}/><button type="submit" className="secondary-btn">조회 포트 저장</button></div>{settingError && <p className="form-error" role="alert">{settingError}</p>}{settingsNotice && <p className="form-ok" role="status">{settingsNotice}</p>}</form><p className="description">모니터링 결과 ({port}): {status?.details ?? "아직 조회되지 않음"}</p><div className="settings-row"><div><strong>자동 상태 확인</strong><p>Tauri 앱에서 10초마다 로컬 서버 상태를 조회합니다.</p></div><button type="button" className={"switch " + (autoRefresh ? "enabled" : "")} role="switch" aria-checked={autoRefresh} aria-label="자동 상태 확인" onClick={() => toggleAutoRefresh(!autoRefresh)}><span /></button></div><div className="info-row"><LockKeyhole size={18}/><div><strong>보안</strong><p>서버 시작/중지, 원격 쓰기 권한, Owner Token은 이 설정에서 변경하지 않습니다.</p></div></div></section>
          <section className="panel page-panel" style={{ marginTop: 20 }}>
            <div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Settings2 size={18}/></span><div><h2>Windows 로그인 시작</h2><p>기존 WinForms와 별도로 Tauri 앱만 실행</p></div></div></div>
            <div className="settings-row">
              <div><strong>Tauri 자동 시작</strong><p>{previewStartup?.details ?? "자동 시작 등록 상태를 조회 중입니다."}</p></div>
              <button type="button" className={"switch " + (previewStartup?.enabled ? "enabled" : "")} role="switch" aria-label="Tauri 로그인 자동 시작" aria-checked={previewStartup?.enabled ?? false}
                disabled={!previewStartup?.supported || startupBusy} onClick={() => { void togglePreviewStartup(!previewStartup?.enabled); }}><span /></button>
            </div>
            {startupError && <p className="form-error" role="alert">{startupError}</p>}
            <div className="info-row"><LockKeyhole size={18}/><div><strong>안전 제한</strong><p>휴대용 ZIP 프리뷰에서는 변경할 수 없습니다. Tauri 전용 설치 경로를 검증한 경우에만 사용자 계정의 별도 등록 항목을 변경하며, 기존 WinForms와 CLI 서버는 변경하지 않습니다.</p></div></div>
          </section>
          <section className="panel page-panel" style={{ marginTop: 20 }}>
            <div className="panel-heading"><div className="panel-title">
              <span className="icon-tile"><TerminalSquare size={18}/></span>
              <div><h2>앱·트레이·종료</h2>
                <p>MCP 제어는 연결 화면에서, Windows 앱 창 제어는 여기에서 관리합니다.</p></div>
            </div></div>
            <div className="legacy-body">
              <div className="legacy-actions">
                <button type="button" className="legacy-action available" disabled={exitBusy}
                  onClick={() => { void hideToTray(); }}>트레이로 숨기기</button>
                <button type="button" className="legacy-action available"
                  disabled={exitBusy || ownedBusy} onClick={() => { void exitPreview(); }}>
                  앱만 종료 (MCP 유지)
                </button>
                <button type="button" className="legacy-action available"
                  disabled={exitBusy || ownedBusy} onClick={() => { void exitPreview(true); }}>
                  앱·전용 MCP 완전 종료
                </button>
              </div>
              <p className="legacy-footnote">앱만 종료하면 전용 MCP/Quick Tunnel은 계속 실행됩니다.
                완전 종료는 소유권 확인 후 Tauri 전용 서버만 중지하며, 기존 WinForms/7979에는 영향을 주지 않습니다.</p>
              {trayError && <p className="form-error" role="alert">{trayError}</p>}
              {exitError && <p className="form-error" role="alert">{exitError}</p>}
            </div>
          </section>
          <LegacySettingsControls />
          <MigrationPreflight report={migrationReport} busy={migrationBusy} error={migrationError}
            onInspect={() => { void runMigrationCheck(); }} onSnapshot={() => { void runMigrationCheck(true); }}
            backup={credentialBackup} backupBusy={backupBusy} backupError={backupError}
            onBackup={() => { void runBackupCheck(true); }} onVerifyBackup={() => { void runBackupCheck(false); }}
            rehearsal={rehearsal} rehearsalBusy={rehearsalBusy} rehearsalError={rehearsalError}
            onRehearse={() => { void runRestoreRehearsal(); }}/>
        </>}

        <footer><span>ChatGPT To Codex · desktop preview</span><span><ExternalLink size={13}/> Local-first • Tauri + React</span></footer>
        </div>
        </div>
      </main>
      {rotationDialogOpen && <OwnerTokenRotationDialog
        busy={ownedBusy} ready={owned?.ready === true} running={owned?.running === true}
        error={ownedError}
        onCancel={() => { if (!ownedBusy) setRotationDialogOpen(false); }}
        onConfirm={() => { void runOwnedAction("rotate-token", true); }}
      />}
      <Toast toast={toast}/>
    </div>
  );
}
export default App;
