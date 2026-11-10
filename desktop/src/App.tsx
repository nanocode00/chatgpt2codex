import {
  Activity, Check, ChevronRight, CircleHelp, Clipboard, Code2, Copy,
  ExternalLink, FolderCode, HardDrive, Layers, LayoutDashboard, LockKeyhole, PlugZap,
  RefreshCcw, Settings2, ShieldCheck, TerminalSquare
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkRuntime, inspectInstalledCli, inspectInstalledCliLogs, inspectPublicTunnel, manageOwnedCli, inspectOwnedPublicTunnelHealth, inspectOwnedCatalog, unregisterOwnedRepository, pickOwnedRepositoryFolder, registerOwnedPickedRepository, cancelOwnedPickedRepository, closePreviewWindow, closePreviewWithOwnedMcp, hidePreviewWindow, openTrustedLink, isNativeApp, inspectPreviewAutostart, setPreviewAutostart, type PreviewStartupInspection, type CliInspection, type CliLogPreview, type CliLogComponent, type ManagedAction, type ManagedResult, type CatalogInspection, type PickedRepositoryFolder, type PublicTunnelHealth, type RuntimeHealth, type TrustedLink } from "./runtime";
import { ManagementControls, LegacyConnectionControls, LegacyDiagnosticsControls, LegacySettingsControls } from "./LegacyControls";
import { CliParityPanel } from "./CliParityPanel";
import { Dashboard } from "./Dashboard";
import { ProjectsScreen } from "./ProjectsScreen";
import { ProfilesScreen } from "./ProfilesScreen";
import { Toast, type AppToast } from "./Toast";
import { storedPublicPreference } from "./dashboard-state";
import { parseUiPort, storedHealthPort, storedAutoRefresh } from "./ui-preferences";
import { MigrationPreflight } from "./MigrationPreflight";
import { inspectLegacyMigration, saveLegacySettingsSnapshot, inspectCredentialBackup, createCredentialBackup, rehearseCredentialRestore, type LegacyMigrationReport, type CredentialBackupReport, type RestoreRehearsalReport } from "./runtime";

type Screen = "overview" | "projects" | "profiles" | "manage" | "cli" | "connections" | "diagnostics" | "settings";
type ActivityEntry = { time: string; message: string; online: boolean };

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
function timeLabel(): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

const NAV: { name: Screen; label: string; icon: typeof LayoutDashboard }[] = [
  { name: "overview", label: "대시보드", icon: LayoutDashboard },
  { name: "projects", label: "프로젝트", icon: FolderCode },
  { name: "profiles", label: "실행 환경", icon: Layers },
  { name: "manage", label: "관리", icon: TerminalSquare },
  { name: "cli", label: "CLI", icon: TerminalSquare },
  { name: "connections", label: "연결", icon: PlugZap },
  { name: "diagnostics", label: "진단", icon: Activity },
  { name: "settings", label: "설정", icon: Settings2 }
];

function App() {
  const native = isNativeApp();
  const [screen, setScreen] = useState<Screen>("overview");
  const [port, setPort] = useState(loadPort);
  const [draftPort, setDraftPort] = useState(String(loadPort()));
  const [autoRefresh, setAutoRefresh] = useState(loadAutoRefresh);
  const [publicPreferred, setPublicPreferred] = useState(loadPublicPreference);
  const [toast, setToast] = useState<AppToast | null>(null);
  const [status, setStatus] = useState<RuntimeHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const [cliChecking, setCliChecking] = useState(false);
  const [cliInspection, setCliInspection] = useState<CliInspection | null>(null);
  const [tunnelHealth, setTunnelHealth] = useState<PublicTunnelHealth | null>(null);
  const [tunnelChecking, setTunnelChecking] = useState(false);
  const [tunnelNotice, setTunnelNotice] = useState("");
  const [logResult, setLogResult] = useState<CliLogPreview | null>(null);
  const [logsChecking, setLogsChecking] = useState(false);
  const [publicCopied, setPublicCopied] = useState(false);
  const [exitError, setExitError] = useState("");
  const [exitBusy, setExitBusy] = useState(false);
  const [trayError, setTrayError] = useState("");
  const [linkError, setLinkError] = useState("");
  const [owned, setOwned] = useState<ManagedResult | null>(null);
  const [ownedBusy, setOwnedBusy] = useState(false);
  const [ownedError, setOwnedError] = useState("");
  const [ownedToken, setOwnedToken] = useState<string | null>(null);
  const [ownedUrlNotice, setOwnedUrlNotice] = useState("");
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
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const [previewStartup, setPreviewStartup] = useState<PreviewStartupInspection | null>(null);
  const [startupBusy, setStartupBusy] = useState(false);
  const [startupError, setStartupError] = useState("");
  const requestCounter = useRef(0);
  const tunnelBusy = useRef(false);
  const lastTunnel = useRef<PublicTunnelHealth | null>(null);
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
      setHistory(prev => [
        { time: timeLabel(), message: next.details, online: next.online },
        ...prev
      ].slice(0, 12));
    } catch (error) {
      if (current !== requestCounter.current) return;
      const detail = error instanceof Error ? error.message : String(error);
      setStatus({ online: false, port, service: "ChatGPT To Codex",
        endpoint: "http://127.0.0.1:" + port + "/mcp",
        details: "검사 실패: " + detail });
      setHistory(prev => [{ time: timeLabel(), message: "상태 확인 중 오류", online: false }, ...prev].slice(0, 12));
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


  const runOwnedAction = useCallback(async (action: ManagedAction) => {
    if (action === "start-public" && !window.confirm(
      "Tauri 전용 MCP를 Cloudflare Quick Tunnel로 외부에 공개할까요?\\n\\n별도 18797 인스턴스만 사용하며 기존 WinForms/7979는 변경하지 않습니다. 공개 주소는 재시작 때 변경될 수 있고, 연결에는 인증 승인이 필요합니다."
    )) return;
    if (action === "rotate-token") {
      const confirmation = window.prompt(
        "Tauri 전용 Owner Token을 새로 발급할까요?\\n\\n기존 Token을 복구할 수 없으며, 기존 OAuth 승인이 모두 무효화돼 ChatGPT를 다시 연결해야 합니다.\\n\\n전용 MCP를 중지한 상태에서만 가능합니다. 진행하려면 '재발급'을 입력하세요."
      );
      if (confirmation !== "재발급") return;
      setOwnedToken(null);
      setOwnedPublicHealth(null);
    }
    setOwnedBusy(true);
    setOwnedError("");
    setOwnedUrlNotice("");
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
    if (screen === "manage" || screen === "overview" || screen === "projects" || screen === "profiles") {
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
      setOwnedUrlNotice("");
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
    } catch {
      setOwnedError("클립보드 복사에 실패했습니다. 토큰을 표시하지 않았으므로 별도 초기화 절차가 필요합니다.");
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

  const runCliInspection = useCallback(async () => {
    setCliChecking(true);
    try {
      setCliInspection(await inspectInstalledCli("default"));
    } catch {
      setCliInspection({
        available: false, instance: "default", alive: false, healthy: false,
        tunnelAlive: null, publicHealthy: null, endpoint: null, publicConnector: null,
        details: "설치된 CLI 상태 조회가 실패했습니다."
      });
    } finally {
      setCliChecking(false);
    }
  }, []);

  useEffect(() => {
    if (screen === "connections") void runCliInspection();
  }, [screen, runCliInspection]);

  const runTunnelCheck = useCallback(async () => {
    // A foreground/resume event can coincide with the one-minute poll.
    if (tunnelBusy.current) return;
    tunnelBusy.current = true;
    setTunnelChecking(true);
    try {
      const next = await inspectPublicTunnel("default");
      const previous = lastTunnel.current;
      if (previous?.endpoint && next.endpoint && previous.endpoint !== next.endpoint) {
        setTunnelNotice("Quick Tunnel 주소가 변경됐습니다. ChatGPT에 등록된 커넥터 주소도 확인하세요.");
      } else if (previous?.state === "online" && next.state === "offline") {
        setTunnelNotice("로컬 MCP와 별개로 공개 터널 연결이 끊겼습니다. WinForms에서 터널 상태를 확인해 주세요.");
      } else if (next.state === "online") {
        setTunnelNotice("");
      }
      setTunnelHealth(next);
      lastTunnel.current = next;
    } catch {
      const failed: PublicTunnelHealth = {
        state: "unavailable", endpoint: null,
        details: "공개 상태를 검사하지 못했습니다."
      };
      setTunnelHealth(failed);
      lastTunnel.current = failed;
    } finally {
      tunnelBusy.current = false;
      setTunnelChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!native) return;
    void runTunnelCheck();
    // Public URLs are less stable than localhost. Check independently, at
    // most once a minute and whenever the WebView resumes / comes to front.
    const interval = window.setInterval(() => { void runTunnelCheck(); }, 60_000);
    const onResume = () => { void runCheck(); void runTunnelCheck(); };
    const onVisible = () => { if (document.visibilityState === "visible") onResume(); };
    window.addEventListener("focus", onResume);
    window.addEventListener("online", onResume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onResume);
      window.removeEventListener("online", onResume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [native, runTunnelCheck, runCheck]);

  const tunnelOnline = tunnelHealth?.state === "online";
  const tunnelOffline = tunnelHealth?.state === "offline";

  const publicConnector = cliInspection?.available ? cliInspection.publicConnector : null;
  const publicState = tunnelHealth?.details ??
    (!cliInspection ? "설치된 CLI에서 공개 연결 정보를 확인합니다." : cliInspection.details);

  function refreshPublicState() {
    void runCliInspection();
    void runTunnelCheck();
  }

  async function copyPublicConnector() {
    if (!publicConnector || tunnelOffline) return;
    try {
      await navigator.clipboard.writeText(publicConnector);
      setPublicCopied(true);
      window.setTimeout(() => setPublicCopied(false), 1500);
    } catch { setPublicCopied(false); }
  }

  async function loadCliLogs(component: CliLogComponent) {
    setLogsChecking(true);
    setLogResult(null);
    try {
      setLogResult(await inspectInstalledCliLogs(component));
    } catch {
      setLogResult({
        available: false, instance: "default", component, truncated: false, content: "",
        details: "CLI 로그 조회 중 오류가 발생했습니다."
      });
    } finally {
      setLogsChecking(false);
    }
  }

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

  async function openLink(kind: TrustedLink) {
    setLinkError("");
    try {
      await openTrustedLink(kind, kind === "local_health" ? port : undefined);
    } catch (error) {
      setLinkError(error instanceof Error ? error.message : String(error));
    }
  }

  const endpoint = useMemo(() => "http://127.0.0.1:" + port + "/mcp", [port]);
  const serverOnline = native && !!status?.online;
  const stateLabel = !native ? "브라우저 미리보기" : checking && !status ? "확인 중" : serverOnline ? "정상 실행 중" : "연결되지 않음";

  async function copyLocalEndpoint() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
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

  function statusTag() {
    return <span className={"status-tag " + (serverOnline ? "online" : "offline")}>
      <span className="status-dot" />{stateLabel}
    </span>;
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
                if (screen === "overview" || screen === "projects" || screen === "manage") {
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
          onNavigate={to => setScreen(to)}
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
          onManageRuntime={() => setScreen("manage")}
        />}

        {screen === "profiles" && <ProfilesScreen
          catalog={catalog} catalogBusy={catalogBusy} catalogError={catalogError}
          onRefresh={refreshCatalog} onNotify={notify}
        />}

        {screen === "manage" && <>
          <div className="page-heading"><div><div className="eyebrow">MANAGEMENT</div><h1>런타임 관리</h1>
            <p>기존 Windows 런처의 관리 항목을 먼저 배치했어. 실제 서버 제어는 안전성 검증 후 연결해.</p></div></div>
          <ManagementControls onConnections={() => setScreen("connections")} onSettings={() => setScreen("settings")} onProjects={() => setScreen("projects")} onExit={() => { void exitPreview(); }} onCompleteExit={() => { void exitPreview(true); }} exitBusy={exitBusy} exitError={exitError}
            onHide={() => { void hideToTray(); }} trayError={trayError}
            owned={owned} ownedBusy={ownedBusy} ownedError={ownedError} ownedToken={ownedToken}
            ownedUrlNotice={ownedUrlNotice} onCopyOwnedConnector={() => { void copyOwnedConnector(); }}
            ownedPublicHealth={ownedPublicHealth} ownedPublicChecking={ownedPublicChecking}
            onCheckOwnedPublicHealth={() => { void checkOwnedPublicHealth(); }}
            catalog={catalog} catalogBusy={catalogBusy} catalogError={catalogError} onRefreshCatalog={() => { void refreshCatalog(); }}
            pickedFolder={pickedFolder} folderBusy={folderBusy} folderName={folderName} onFolderName={setFolderName}
            folderId={folderId} onFolderId={setFolderId} folderError={folderError} folderNotice={folderNotice}
            onBrowseFolder={() => { void browseOwnedFolder(); }} onCancelFolder={() => { void discardOwnedFolder(); }}
            onRegisterFolder={() => { void registerOwnedFolder(); }}
            unregisterTarget={unregisterTarget} unregisterTyped={unregisterTyped}
            onUnregisterTyped={setUnregisterTyped} unregisterBusy={unregisterBusy}
            unregisterError={unregisterError} unregisterNotice={unregisterNotice}
            onRequestUnregister={requestUnregister} onCancelUnregister={cancelUnregister}
            onConfirmUnregister={() => { void confirmUnregister(); }}
            onOwnedAction={(action) => { void runOwnedAction(action); }} onCopyToken={() => { void copyOwnedToken(); }}/>
        </>}

        {screen === "cli" && <>
          <div className="page-heading"><div><div className="eyebrow">CLI PARITY</div><h1>고급 CLI</h1><p>실행 환경은 전용 화면에서 관리합니다. 이곳에서는 설정·진단·고급 조회만 제공합니다.</p></div></div>
          <CliParityPanel />
        </>}

        {screen === "connections" && <>
          <div className="page-heading"><div><div className="eyebrow">CONNECTIVITY</div><h1>연결</h1><p>C2C 서버의 로컬 주소와 연결 가능 상태를 확인합니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><PlugZap size={18}/></span><div><h2>로컬 MCP 엔드포인트</h2><p>로컬 상태 검사와 동일한 포트를 사용합니다.</p></div></div>{statusTag()}</div><label className="field-label" htmlFor="connections-endpoint">LOCAL ADDRESS</label><div className="endpoint roomy"><input id="connections-endpoint" readOnly value={endpoint}/><button type="button" onClick={() => { void copyLocalEndpoint(); }}>{copied ? <Check size={16}/> : <Clipboard size={16}/>} {copied ? "복사 완료" : "복사"}</button></div><div className="info-row"><ShieldCheck size={18}/><div><strong>로컬 주소만 표시</strong><p>Owner Token을 읽거나 표시하지 않으며 외부 터널을 생성하지 않습니다.</p></div></div><div className="info-row"><CircleHelp size={18}/><div><strong>ChatGPT 웹 연결은 별도 설정</strong><p>기존 Windows 앱의 터널은 별도로 관리됩니다. 새 Tauri 전용 Quick Tunnel의 시작·외부 Health 검사는 관리 화면에서 수행하며 18797 인스턴스만 사용합니다.</p></div></div></section>
          <section className="panel page-panel" style={{ marginTop: 20 }}>
            <div className="panel-heading">
              <div className="panel-title"><span className="icon-tile"><TerminalSquare size={18}/></span>
                <div><h2>CLI 관리 인스턴스</h2><p>기존 Windows 설치본 · default 인스턴스</p></div>
              </div>
              <button className="secondary-btn" type="button" disabled={cliChecking} onClick={() => { void runCliInspection(); }}>
                <RefreshCcw size={15}/>{cliChecking ? "조회 중..." : "CLI 조회"}
              </button>
            </div>
            <div className="info-row">
              <ShieldCheck size={18}/>
              <div>
                <strong>{cliInspection?.available ? (cliInspection.healthy ? "CLI 인스턴스 정상" : "CLI 인스턴스 미응답") : "CLI 확인 필요"}</strong>
                <p>{cliInspection?.details ?? "CLI 상태 정보를 조회하는 중입니다."}</p>
                {cliInspection?.available && <p>인스턴스: {cliInspection.instance} · 서버: {cliInspection.alive ? "실행 중" : "꺼짐"} · 터널: {cliInspection.tunnelAlive === null ? "정보 없음" : cliInspection.tunnelAlive ? "실행 중" : "꺼짐"}</p>}
                {cliInspection?.available && cliInspection.endpoint && <p>CLI Health: {cliInspection.endpoint}</p>}
              </div>
            </div>
            <div className="info-row">
              <LockKeyhole size={18}/>
              <div><strong>안전한 읽기 전용 연결</strong>
                <p>설치된 CLI의 health 명령만 사용합니다. MCP 서버를 시작·종료하지 않고 Owner Token도 읽지 않습니다.</p>
              </div>
            </div>
          </section>
          <LegacyConnectionControls publicConnector={publicConnector ?? null} publicState={publicState} publicVerified={tunnelOnline} publicOffline={tunnelOffline} publicNotice={tunnelNotice} onCopyPublic={() => { void copyPublicConnector(); }} publicCopied={publicCopied} onRefreshPublic={refreshPublicState} checking={cliChecking || tunnelChecking}/>
        </>}

        {screen === "diagnostics" && <>
          <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>진단</h1><p>로컬 Health 검사 기록과 설치된 CLI의 서버·터널 로그를 확인합니다.</p></div><button className="secondary-btn" onClick={() => { void runCheck(); }} disabled={checking}><RefreshCcw size={16}/> 다시 확인</button></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Activity size={18}/></span><div><h2>상태 확인 기록</h2><p>현재 세션 · 최근 12건</p></div></div>{statusTag()}</div><div className="event-list">{history.length ? history.map((item, i) => <div className="event" key={item.time + i}><span className={"event-dot " + (item.online ? "ok" : "")}/><div><strong>{item.online ? "Health 확인 성공" : "Health 확인"}</strong><p>{item.message}</p></div><time>{item.time}</time></div>) : <p className="description">아직 검사 기록이 없습니다.</p>}</div></section>
          <LegacyDiagnosticsControls checking={checking} onLocalHealth={() => { void runCheck(); }} onPublicHealth={refreshPublicState} tunnelChecking={tunnelChecking || cliChecking} tunnelStatus={tunnelHealth?.details ?? "아직 검사하지 않았습니다."} onViewLogs={(component) => { void loadCliLogs(component); }} logsChecking={logsChecking} logResult={logResult}
            native={native} localVerified={serverOnline} localChecked={status !== null} localDetails={status?.details ?? "로컬 MCP 서버 상태를 확인하고 있습니다."} localPort={port}
            publicVerified={tunnelOnline} publicHealthState={tunnelHealth?.state ?? null} openError={linkError}
            onOpenLocalHealth={() => { void openLink("local_health"); }} onOpenPublicHealth={() => { void openLink("public_health"); }}
            onOpenGithub={() => { void openLink("github"); }} onOpenDeveloper={() => { void openLink("developer"); }}/>
        </>}

        {screen === "settings" && <>
          <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>모니터링과 별도 Tauri 자동 시작 상태를 관리합니다. 기존 C2C CLI 설정은 변경하지 않습니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Settings2 size={18}/></span><div><h2>모니터링</h2><p>조회 대상과 갱신 주기를 관리합니다.</p></div></div></div><form onSubmit={saveSettings} className="settings-form"><label htmlFor="port-setting">로컬 MCP 포트</label><p>상태 확인 요청을 보낼 localhost 포트입니다.</p><div className="setting-control"><input id="port-setting" type="number" min="1" max="65535" value={draftPort} onChange={event => setDraftPort(event.target.value)}/><button type="submit" className="secondary-btn">조회 포트 저장</button></div>{settingError && <p className="form-error" role="alert">{settingError}</p>}{settingsNotice && <p className="form-ok" role="status">{settingsNotice}</p>}</form><div className="settings-row"><div><strong>자동 상태 확인</strong><p>Tauri 앱에서 10초마다 로컬 서버 상태를 조회합니다.</p></div><button type="button" className={"switch " + (autoRefresh ? "enabled" : "")} role="switch" aria-checked={autoRefresh} aria-label="자동 상태 확인" onClick={() => toggleAutoRefresh(!autoRefresh)}><span /></button></div><div className="info-row"><LockKeyhole size={18}/><div><strong>보안</strong><p>서버 시작/중지, 원격 쓰기 권한, Owner Token은 이 설정에서 변경하지 않습니다.</p></div></div></section>
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
      <Toast toast={toast}/>
    </div>
  );
}
export default App;
