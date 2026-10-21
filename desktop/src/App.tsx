import {
  Activity, ArrowUpRight, Check, ChevronRight, CircleAlert, CircleHelp,
  Clipboard, Clock3, Code2, Copy, ExternalLink, FolderCode, Gauge,
  HardDrive, LayoutDashboard, LockKeyhole, PlugZap, RefreshCcw,
  Settings2, ShieldCheck, TerminalSquare, Wifi, WifiOff
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { checkRuntime, isNativeApp, type RuntimeHealth } from "./runtime";

type Screen = "overview" | "connections" | "diagnostics" | "settings";
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
  const [history, setHistory] = useState<ActivityEntry[]>([]);
  const [copied, setCopied] = useState(false);
  const [settingError, setSettingError] = useState("");
  const [settingsNotice, setSettingsNotice] = useState("");
  const requestCounter = useRef(0);

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
            <div className="metric"><div className="metric-label"><ShieldCheck size={17}/>접근 범위</div><strong>Local</strong><span>읽기 전용 상태 조회</span></div>
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
                <div className="informative-note"><CircleAlert size={16}/><span>로컬 주소는 ChatGPT 웹에서 직접 접근할 수 없어요. 외부 터널은 아직 이 화면에서 관리하지 않습니다.</span></div>
                <button type="button" className="text-action" onClick={() => setScreen("connections")}>연결 자세히 보기 <ChevronRight size={16}/></button>
              </section>
              <section className="panel project-panel">
                <div className="panel-heading"><div className="panel-title"><span className="icon-tile"><FolderCode size={18}/></span><div><h2>프로젝트 관리</h2><p>CLI 공통 인스턴스 연동 준비 중</p></div></div></div>
                <p className="description">프로젝트 목록과 프로필은 기존 C2C CLI가 관리합니다. 다음 단계에서 공통 관리 기능을 연결할 예정입니다.</p>
                <span className="coming-soon">CLI 연동 예정</span>
              </section>
            </div>
          </div>
        </>}

        {screen === "connections" && <>
          <div className="page-heading"><div><div className="eyebrow">CONNECTIVITY</div><h1>연결</h1><p>C2C 서버의 로컬 주소와 연결 가능 상태를 확인합니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><PlugZap size={18}/></span><div><h2>로컬 MCP 엔드포인트</h2><p>로컬 상태 검사와 동일한 포트를 사용합니다.</p></div></div>{statusTag()}</div><label className="field-label" htmlFor="connections-endpoint">LOCAL ADDRESS</label><div className="endpoint roomy"><input id="connections-endpoint" readOnly value={endpoint}/><button type="button" onClick={() => { void copyLocalEndpoint(); }}>{copied ? <Check size={16}/> : <Clipboard size={16}/>} {copied ? "복사 완료" : "복사"}</button></div><div className="info-row"><ShieldCheck size={18}/><div><strong>로컬 주소만 표시</strong><p>Owner Token을 읽거나 표시하지 않으며 외부 터널을 생성하지 않습니다.</p></div></div><div className="info-row"><CircleHelp size={18}/><div><strong>ChatGPT 웹 연결은 별도 설정</strong><p>기존 Windows 앱의 Cloudflare Quick Tunnel은 재시작 시 주소가 달라질 수 있습니다. 이 프리뷰는 터널 설정을 변경하지 않습니다.</p></div></div></section>
        </>}

        {screen === "diagnostics" && <>
          <div className="page-heading"><div><div className="eyebrow">DIAGNOSTICS</div><h1>진단</h1><p>실제 로컬 Health 요청 결과만 기록합니다. 서버 로그 조회는 다음 단계에서 연결합니다.</p></div><button className="secondary-btn" onClick={() => { void runCheck(); }} disabled={checking}><RefreshCcw size={16}/> 다시 확인</button></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Activity size={18}/></span><div><h2>상태 확인 기록</h2><p>현재 세션 · 최근 12건</p></div></div>{statusTag()}</div><div className="event-list">{history.length ? history.map((item, i) => <div className="event" key={item.time + i}><span className={"event-dot " + (item.online ? "ok" : "")}/><div><strong>{item.online ? "Health 확인 성공" : "Health 확인"}</strong><p>{item.message}</p></div><time>{item.time}</time></div>) : <p className="description">아직 검사 기록이 없습니다.</p>}</div></section>
        </>}

        {screen === "settings" && <>
          <div className="page-heading"><div><div className="eyebrow">PREFERENCES</div><h1>설정</h1><p>이 프리뷰의 상태 확인 방식만 설정합니다. C2C CLI 설정은 변경하지 않습니다.</p></div></div>
          <section className="panel page-panel"><div className="panel-heading"><div className="panel-title"><span className="icon-tile"><Settings2 size={18}/></span><div><h2>모니터링</h2><p>조회 대상과 갱신 주기를 관리합니다.</p></div></div></div><form onSubmit={saveSettings} className="settings-form"><label htmlFor="port-setting">로컬 MCP 포트</label><p>상태 확인 요청을 보낼 localhost 포트입니다.</p><div className="setting-control"><input id="port-setting" type="number" min="1" max="65535" value={draftPort} onChange={event => setDraftPort(event.target.value)}/><button type="submit" className="secondary-btn">조회 포트 저장</button></div>{settingError && <p className="form-error" role="alert">{settingError}</p>}{settingsNotice && <p className="form-ok" role="status">{settingsNotice}</p>}</form><div className="settings-row"><div><strong>자동 상태 확인</strong><p>Tauri 앱에서 10초마다 로컬 서버 상태를 조회합니다.</p></div><button type="button" className={"switch " + (autoRefresh ? "enabled" : "")} role="switch" aria-checked={autoRefresh} aria-label="자동 상태 확인" onClick={() => toggleAutoRefresh(!autoRefresh)}><span /></button></div><div className="info-row"><LockKeyhole size={18}/><div><strong>보안</strong><p>이 화면은 읽기 전용입니다. 서버 시작/중지, 원격 쓰기 권한, Owner Token은 건드리지 않습니다.</p></div></div></section>
        </>}

        <footer><span>ChatGPT To Codex · desktop preview</span><span><ExternalLink size={13}/> Local-first • Tauri + React</span></footer>
        </div>
        </div>
      </main>
    </div>
  );
}
export default App;
