import {
  Activity, ArrowUpRight, Check, ChevronRight, CircleAlert, CircleHelp,
  Clipboard, Clock3, Code2, Copy, ExternalLink, FolderCode, Gauge,
  HardDrive, LayoutDashboard, LockKeyhole, PlugZap, RefreshCcw,
  Settings2, ShieldCheck, TerminalSquare, Wifi, WifiOff
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkRuntime, inspectInstalledCli, inspectInstalledCliLogs, inspectPublicTunnel, manageOwnedCli, closePreviewWindow, isNativeApp, type CliInspection, type CliLogPreview, type CliLogComponent, type ManagedAction, type ManagedResult, type PublicTunnelHealth, type RuntimeHealth } from "./runtime";
import { ManagementControls, LegacyConnectionControls, LegacyDiagnosticsControls, LegacySettingsControls } from "./LegacyControls";
import { MigrationPreflight } from "./MigrationPreflight";
import { inspectLegacyMigration, saveLegacySettingsSnapshot, type LegacyMigrationReport } from "./runtime";

type Screen = "overview" | "manage" | "connections" | "diagnostics" | "settings";
type ActivityEntry = { time: string; message: string; online: boolean };

function loadPort(): number {
  try {
    const raw = Number.parseInt(localStorage.getItem("c2c.desktop.health-port") || "7979", 10);
    return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : 7979;
  } catch {
    return 7979;
  }
}
function loadAutoRefresh(): boolean {
  try { return localStorage.getItem("c2c.desktop.autorefresh") !== "false"; }
  catch { return true; }
}
function timeLabel(): string {
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date());
}

const NAV: { name: Screen; label: string; icon: typeof LayoutDashboard }[] = [
  { name: "overview", label: "개요", icon: LayoutDashboard },
  { name: "manage", label: "관리", icon: TerminalSquare },
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
  const [owned, setOwned] = useState<ManagedResult | null>(null);
  const [ownedBusy, setOwnedBusy] = useState(false);
  const [ownedError, setOwnedError] = useState("");
  const [ownedToken, setOwnedToken] = useState<string | null>(null);
  const [migrationReport, setMigrationReport] = useState<LegacyMigrationReport | null>(null);
  const [migrationBusy, setMigrationBusy] = useState(false);
  const [migrationError, setMigrationError] = useState("");
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const requestCounter = useRef(0);
  const tunnelBusy = useRef(false);
  const lastTunnel = useRef<PublicTunnelHealth | null>(null);

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
    if (!autoRefresh || !native) return;
    const interval = setInterval(() => { void runCheck(); }, 10_000);
    return () => clearInterval(interval);
  }, [autoRefresh, native, runCheck]);


  const runOwnedAction = useCallback(async (action: ManagedAction) => {
    setOwnedBusy(true);
    setOwnedError("");
    try {
      const next = await manageOwnedCli(action);
      if (next.oneTimeOwnerToken) {
        setOwnedToken(next.oneTimeOwnerToken);
        setOwned({ ...next, oneTimeOwnerToken: undefined });
      } else {
        setOwned(next);
      }
    } catch (error) {
      setOwnedError(error instanceof Error ? error.message : "전용 CLI 작업에 실패했습니다.");
    } finally {
      setOwnedBusy(false);
    }
  }, []);

  useEffect(() => {
    if (screen === "manage") void runOwnedAction("status");
  }, [screen, runOwnedAction]);

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

  useEffect(() => {
    if (screen === "settings" && native) void runMigrationCheck();
  }, [screen, native, runMigrationCheck]);

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
  const tunnelLabel = tunnelOnline ? "Online" : tunnelOffline ? "Offline" : "미확인";

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

  async function exitPreview() {
    try {
      await closePreviewWindow();
    } catch {
      setExitError("Tauri 창을 닫지 못했습니다. 창의 X 버튼으로 종료해 주세요.");
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
    const next = Number(draftPort);
    if (!Number.isInteger(next) || next < 1 || next > 65535) {
      setSettingError("포트는 1부터 65535까지의 정수여야 합니다.");
      setSettingsNotice("");
      return;
    }
    setSettingError("");
    setSettingsNotice("로컬 상태 검사 대상 포트만 변경했어. 실제 C2C 서버 설정은 그대로야.");
    localStorage.setItem("c2c.desktop.health-port", String(next));
    setPort(next);
  }

  function toggleAutoRefresh(next: boolean) {
    setAutoRefresh(next);
    localStorage.setItem("c2c.desktop.autorefresh", String(next));
  }

  function statusTag() {
    return <span className={"status-tag " + (serverOnline ? "online" : "offline")}>
      <span className="status-dot" />{stateLabel}
    </span>;
  }

  const statusLine = status?.details || "로컬 C2C 서비스의 상태를 확인하고 있어요.";

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
          <span><strong>로컬 MCP</strong><small>127.0.0.1:{port}</small></span>
          <span className={"tiny-led " + (serverOnline ? "glow" : "")} />
        </button>
        <div className="sidebar-bottom">
          <div className="mini-security"><ShieldCheck size={16} /><span>읽기 전용 모니터링</span></div>
          <div className="sidebar-version">Preview 0.1 · Tauri 2</div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb"><span>ChatGPT To Codex</span><ChevronRight size={15}/><strong>{NAV.find(n => n.name === screen)?.label}</strong></div>
          <div className="header-actions">
            <span className="host-indicator"><span className={"host-dot " + (native ? "connected" : "")} />{native ? "이 컴퓨터" : "웹 미리보기"}</span>
            <button className={"icon-btn " + (checking ? "spin-icon" : "")} type="button" onClick={() => { void runCheck(); }} aria-label="상태 새로고침" title="상태 새로고침" disabled={checking}><RefreshCcw size={17}/></button>
          </div>
        </header>

        <div className="page-scroll">
        <div className="page-content">
        {screen === "overview" && <>
          <div className="page-heading"><div><div className="eyebrow">LOCAL DEVELOPMENT</div><h1>개발 환경, 한눈에.</h1><p>로컬 MCP 서버의 연결 상태와 프로젝트 실행 환경을 확인하세요.</p></div><button className="secondary-btn" type="button" onClick={() => setScreen("diagnostics")}><Activity size={16}/> 진단 보기 <ArrowUpRight size={14}/></button></div>
          <div className="metrics">
            <div className="metric"><div className="metric-label"><Gauge size={17}/>런타임 상태</div><strong>{serverOnline ? "Online" : "Offline"}</strong><span>{stateLabel}</span></div>
            <div className="metric"><div className="metric-label"><TerminalSquare size={17}/>로컬 포트</div><strong>{port}</strong><span>127.0.0.1</span></div>
            <div className="metric"><div className="metric-label"><ShieldCheck size={17}/>공개 터널</div><strong>{tunnelLabel}</strong><span>{tunnelOnline ? "HTTPS Health 확인" : tunnelOffline ? "외부 연결 실패 · 로컬은 별도" : "상태 확인 필요"}</span></div>
          </div>

          <div className="content-grid">
            <section className="panel runtime-panel">
              <div className="panel-heading"><div className="panel-title"><span className="icon-tile"><TerminalSquare size={18}/></span><div><h2>C2C Runtime</h2><p>이 컴퓨터에서 실행 중인 서비스</p></div></div>{statusTag()}</div>
              <div className="runtime-hero">
                <div className={"orbit " + (serverOnline ? "orbit-online" : "")}><div className="orbit-inner">{serverOnline ? <Wifi size={28}/> : <WifiOff size={28}/>}</div></div>
                <strong>{serverOnline ? "서버가 연결되었어요" : native ? "서버가 대기 중이에요" : "네이티브 앱에서 연결하세요"}</strong>
                <span>{statusLine}</span>
              </div>
              <div className="panel-footer"><div className="muted-row"><Clock3 size={15}/> {autoRefresh && native ? "10초 간격 자동 확인" : "수동 확인"}</div><button type="button" className="secondary-btn" onClick={() => { void runCheck(); }} disabled={checking}><RefreshCcw size={15}/> {checking ? "확인 중..." : "다시 확인"}</button></div>
            </section>

            <div className="right-column">
              <section className="panel connection-preview">
                <div className="panel-heading"><div className="panel-title"><span className="icon-tile"><PlugZap size={18}/></span><div><h2>MCP 연결</h2><p>로컬 커넥터 주소</p></div></div></div>
                <label className="field-label" htmlFor="overview-endpoint">Local endpoint</label>
                <div className="endpoint"><input id="overview-endpoint" readOnly value={endpoint} aria-label="로컬 MCP URL"/><button type="button" aria-label="로컬 URL 복사" onClick={() => { void copyLocalEndpoint(); }}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button></div>
                <div className="informative-note"><CircleAlert size={16}/><span>{tunnelOffline ? "로컬 MCP는 정상이어도 공개 Quick Tunnel은 현재 연결되지 않습니다." : "로컬 주소는 ChatGPT 웹에서 직접 접근할 수 없어요. 공개 터널은 별도로 검사합니다."}</span></div>
                <button type="button" className="text-action" onClick={() => setScreen("connections")}>연결 자세히 보기 <ChevronRight size={16}/></button>
              </section>
              <section className="panel project-panel">
                <div className="panel-heading"><div className="panel-title"><span className="icon-tile"><FolderCode size={18}/></span><div><h2>프로젝트 관리</h2><p>CLI 공통 인스턴스 연동 준비 중</p></div></div></div>
                <p className="description">프로젝트 목록과 프로필은 기존 C2C CLI가 관리합니다. 다음 단계에서 공통 관리 기능을 연결할 예정입니다.</p>
                <span className="coming-soon">CLI 연동 예정</span>
                <button type="button" className="text-action legacy-link" onClick={() => setScreen("manage")}>관리 화면 보기 <ChevronRight size={16}/></button>
              </section>
            </div>
          </div>
        </>}

        {screen === "manage" && <>
          <div className="page-heading"><div><div className="eyebrow">MANAGEMENT</div><h1>런타임 관리</h1>
            <p>기존 Windows 런처의 관리 항목을 먼저 배치했어. 실제 서버 제어는 안전성 검증 후 연결해.</p></div></div>
          <ManagementControls onConnections={() => setScreen("connections")} onSettings={() => setScreen("settings")} onExit={() => { void exitPreview(); }} exitError={exitError}
            owned={owned} ownedBusy={ownedBusy} ownedError={ownedError} ownedToken={ownedToken}
            onOwnedAction={(action) => { void runOwnedAction(action); }} onCopyToken={() => { void copyOwnedToken(); }}/>
        </>}

        {screen === "connections" && <>
          <div className="page-heading"><div><div className="eyebrow">CONNECTIVITY</div><h1>연결</h1><p>C2C 서버의 로컬 주소와 연결 가능 상태를 확인합니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><PlugZap size={18}/></span><div><h2>로컬 MCP 엔드포인트</h2><p>로컬 상태 검사와 동일한 포트를 사용합니다.</p></div></div>{statusTag()}</div><label className="field-label" htmlFor="connections-endpoint">LOCAL ADDRESS</label><div className="endpoint roomy"><input id="connections-endpoint" readOnly value={endpoint}/><button type="button" onClick={() => { void copyLocalEndpoint(); }}>{copied ? <Check size={16}/> : <Clipboard size={16}/>} {copied ? "복사 완료" : "복사"}</button></div><div className="info-row"><ShieldCheck size={18}/><div><strong>로컬 주소만 표시</strong><p>Owner Token을 읽거나 표시하지 않으며 외부 터널을 생성하지 않습니다.</p></div></div><div className="info-row"><CircleHelp size={18}/><div><strong>ChatGPT 웹 연결은 별도 설정</strong><p>기존 Windows 앱의 Cloudflare Quick Tunnel은 재시작 시 주소가 달라질 수 있습니다. 이 프리뷰는 터널 설정을 변경하지 않습니다.</p></div></div></section>
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
          <LegacyDiagnosticsControls checking={checking} onLocalHealth={() => { void runCheck(); }} onPublicHealth={refreshPublicState} tunnelChecking={tunnelChecking || cliChecking} tunnelStatus={tunnelHealth?.details ?? "아직 검사하지 않았습니다."} onViewLogs={(component) => { void loadCliLogs(component); }} logsChecking={logsChecking} logResult={logResult}/>
        </>}

        {screen === "settings" && <>
          <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>이 프리뷰의 상태 확인 방식만 설정합니다. C2C CLI 설정은 변경하지 않습니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Settings2 size={18}/></span><div><h2>모니터링</h2><p>조회 대상과 갱신 주기를 관리합니다.</p></div></div></div><form onSubmit={saveSettings} className="settings-form"><label htmlFor="port-setting">로컬 MCP 포트</label><p>상태 확인 요청을 보낼 localhost 포트입니다.</p><div className="setting-control"><input id="port-setting" type="number" min="1" max="65535" value={draftPort} onChange={event => setDraftPort(event.target.value)}/><button type="submit" className="secondary-btn">조회 포트 저장</button></div>{settingError && <p className="form-error" role="alert">{settingError}</p>}{settingsNotice && <p className="form-ok" role="status">{settingsNotice}</p>}</form><div className="settings-row"><div><strong>자동 상태 확인</strong><p>Tauri 앱에서 10초마다 로컬 서버 상태를 조회합니다.</p></div><button type="button" className={"switch " + (autoRefresh ? "enabled" : "")} role="switch" aria-checked={autoRefresh} aria-label="자동 상태 확인" onClick={() => toggleAutoRefresh(!autoRefresh)}><span /></button></div><div className="info-row"><LockKeyhole size={18}/><div><strong>보안</strong><p>현재 동작하는 것은 모니터링 설정뿐입니다. 서버 시작/중지, 원격 쓰기 권한, Owner Token은 건드리지 않습니다.</p></div></div></section>
          <LegacySettingsControls />
          <MigrationPreflight report={migrationReport} busy={migrationBusy} error={migrationError}
            onInspect={() => { void runMigrationCheck(); }} onSnapshot={() => { void runMigrationCheck(true); }}/>
        </>}

        <footer><span>ChatGPT To Codex · desktop preview</span><span><ExternalLink size={13}/> Local-first • Tauri + React</span></footer>
        </div>
        </div>
      </main>
    </div>
  );
}
export default App;
