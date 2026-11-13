import { useEffect, useState } from "react";
import {
  Activity, AlertTriangle, ArrowRight, CheckCircle2, ClipboardList,
  Cloud, FileText, HeartPulse, LockKeyhole, RefreshCcw,
  RotateCcw, ShieldCheck, TerminalSquare, X
} from "lucide-react";
import { runOwnedCliParity, type ManagedResult, type OwnedCliParityOperation, type PublicTunnelHealth } from "./runtime";
import { displayCliText, parseHealth, parseLocks, parseRuntimeStatus,
  type HealthDiagnostic, type LockDiagnostic, type RuntimeDiagnostic } from "./diagnostics-model";
import "./diagnostics.css";

interface DiagnosticsScreenProps {
  native: boolean;
  owned: ManagedResult | null;
  ownedBusy: boolean;
  ownedError: string;
  publicHealth: PublicTunnelHealth | null;
  publicChecking: boolean;
  refreshKey: number;
  onRefreshOwned: () => void;
  onRefreshPublic: () => void;
  onConnections: () => void;
  onNotify: (message: string, tone?: "info" | "error") => void;
}

function failure(error: unknown): string {
  return (typeof error === "string" ? error : error instanceof Error ? error.message : "진단 작업에 실패했습니다.")
    .slice(0, 340);
}
const labelTime = () => new Intl.DateTimeFormat("ko-KR", {
  hour: "2-digit", minute: "2-digit", second: "2-digit"
}).format(new Date());

export function DiagnosticsScreen({
  native, owned, ownedBusy, ownedError, publicHealth, publicChecking, refreshKey,
  onRefreshOwned, onRefreshPublic, onConnections, onNotify
}: DiagnosticsScreenProps) {
  const [runtime, setRuntime] = useState<RuntimeDiagnostic | null>(null);
  const [health, setHealth] = useState<HealthDiagnostic | null>(null);
  const [locks, setLocks] = useState<LockDiagnostic[] | null>(null);
  const [checkedAt, setCheckedAt] = useState("");
  const [snapshotError, setSnapshotError] = useState("");
  const [busy, setBusy] = useState<"overview" | "doctor" | "logs" | "locks" | "reload" | null>(null);
  const [doctor, setDoctor] = useState<string | null>(null);
  const [doctorError, setDoctorError] = useState("");
  const [logTab, setLogTab] = useState<"server" | "tunnel">("server");
  const [logText, setLogText] = useState<string | null>(null);
  const [logError, setLogError] = useState("");
  const [reloadOpen, setReloadOpen] = useState(false);
  const [reloadResult, setReloadResult] = useState("");
  const [reloadError, setReloadError] = useState("");
  const [lockExpanded, setLockExpanded] = useState(false);
  const [lockError, setLockError] = useState("");

  async function fetchOverview(): Promise<void> {
    setBusy("overview");
    setSnapshotError("");
    try {
      const [s, h] = await Promise.allSettled([
        runOwnedCliParity({ operation: "status" }),
        runOwnedCliParity({ operation: "health" })
      ]);
      const valueStatus = s.status === "fulfilled" ? parseRuntimeStatus(s.value.json) : null;
      const valueHealth = h.status === "fulfilled" ? parseHealth(h.value.json) : null;
      setRuntime(valueStatus);
      setHealth(valueHealth);
      const errors = [
        s.status === "rejected" ? "상태: " + failure(s.reason) : !valueStatus ? "상태: CLI 형식 확인 필요" : "",
        h.status === "rejected" ? "Health: " + failure(h.reason) : !valueHealth ? "Health: CLI 형식 확인 필요" : ""
      ].filter(Boolean);
      setSnapshotError(errors.join(" · ").slice(0, 650));
      setCheckedAt(labelTime());
    } finally { setBusy(null); }
  }

  // This screen is mounted only while selected. Only query the owned CLI instance.
  useEffect(() => {
    if (!native) return;
    let active = true;
    const init = async () => {
      setBusy("overview");
      try {
        const result = await Promise.allSettled([
          runOwnedCliParity({ operation: "status" }),
          runOwnedCliParity({ operation: "health" })
        ]);
        if (!active) return;
        const [s, h] = result;
        const rs = s.status === "fulfilled" ? parseRuntimeStatus(s.value.json) : null;
        const rh = h.status === "fulfilled" ? parseHealth(h.value.json) : null;
        setRuntime(rs); setHealth(rh); setCheckedAt(labelTime());
        setSnapshotError([
          s.status === "rejected" ? "상태: " + failure(s.reason) : !rs ? "상태: 응답 형식 확인 필요" : "",
          h.status === "rejected" ? "Health: " + failure(h.reason) : !rh ? "Health: 응답 형식 확인 필요" : ""
        ].filter(Boolean).join(" · ").slice(0, 650));
      } finally { if (active) setBusy(null); }
    };
    void init();
    return () => { active = false; };
  }, [native, refreshKey]);

  async function refresh() {
    if (busy || !native) return;
    onRefreshOwned();
    if (owned?.tunnelRunning) onRefreshPublic();
    await fetchOverview();
  }
  async function checkDoctor() {
    if (busy || !native) return;
    setBusy("doctor"); setDoctorError(""); setDoctor(null);
    try {
      const r = await runOwnedCliParity({ operation: "doctor" });
      setDoctor(displayCliText(r.text));
    } catch (e) { setDoctorError(failure(e)); }
    finally { setBusy(null); }
  }
  async function getLogs(which: "server" | "tunnel") {
    if (busy || !native) return;
    setLogTab(which); setBusy("logs"); setLogError(""); setLogText(null);
    const op: OwnedCliParityOperation = which === "server" ? "logs-server" : "logs-tunnel";
    try {
      const r = await runOwnedCliParity({ operation: op });
      setLogText(displayCliText(r.text));
    } catch (e) { setLogError(failure(e)); }
    finally { setBusy(null); }
  }
  async function checkLocks() {
    if (busy || !native) return;
    setBusy("locks"); setLockError("");
    try {
      const r = await runOwnedCliParity({ operation: "lock-list" });
      const result = parseLocks(r.json);
      if (!result) throw new Error("잠금 목록의 응답 형식을 확인할 수 없습니다.");
      setLocks(result);
    } catch (e) { setLockError(failure(e)); setLocks(null); }
    finally { setBusy(null); }
  }
  async function reload() {
    if (busy || !native || !owned?.running || ownedBusy || !reloadOpen) return;
    setBusy("reload"); setReloadError(""); setReloadResult("");
    try {
      const result = await runOwnedCliParity({ operation: "reload" });
      const response = result.json;
      if (!response || typeof response !== "object" || Array.isArray(response) ||
          (response as Record<string, unknown>).reloaded !== true) {
        throw new Error("CLI가 재로드 완료를 명시적으로 확인하지 않았습니다.");
      }
      setReloadOpen(false);
      setReloadResult("Tauri 전용 프로젝트·실행 환경 구성 재로드가 확인되었습니다.");
      onNotify("Tauri 전용 프로젝트·실행 환경 재로드 완료");
    } catch (e) {
      setReloadError(failure(e));
    } finally { setBusy(null); }
  }

  const isBusy = busy !== null || ownedBusy;
  const active = runtime?.healthy === true && health?.healthy === true;
  const localLabel = busy === "overview" ? "점검 중" : !runtime || !health ? "미확인" :
    active ? "정상 응답" : runtime.alive ? "실행 중 · Health 실패" : "중지됨";
  const publicLabel = owned === null ? "외부 공개 미확인" : !owned.tunnelRunning ? "외부 공개 없음" :
    publicChecking ? "HTTPS 확인 중" :
    publicHealth?.state === "online" ? "HTTPS 응답 정상" :
    publicHealth?.state === "offline" ? "HTTPS 응답 실패" : "외부 상태 미확인";
  const holderCount = locks?.reduce((sum, lock) => sum + (lock.writer ? 1 : 0) + lock.readers.length, 0) ?? 0;
  const lockLabel = busy === "locks" ? "조회 중" : locks === null ? "조회 안 됨" :
    holderCount === 0 ? "활성 잠금 없음" : "잠금 " + holderCount + "개";
  const visibleLocks = lockExpanded ? locks ?? [] : (locks ?? []).slice(0, 5);

  return <div className="diag-root">
    <header className="diag-heading">
      <div>
        <p className="diag-eyebrow">DIAGNOSTICS / RECOVERY</p>
        <h1>진단·복구</h1>
        <p>Tauri 전용 MCP의 실행 상태, 진단 결과, 로그와 프로젝트 잠금을 확인합니다.</p>
      </div>
      <button className="diag-button secondary" type="button" disabled={!native || isBusy}
        onClick={() => { void refresh(); }}>
        <RefreshCcw size={16}/> 전체 점검
      </button>
    </header>

    <div className="diag-summary" aria-label="진단 요약">
      <div><HeartPulse size={19}/><strong>{localLabel}</strong><span>로컬 MCP · 127.0.0.1:{owned?.port ?? 7979}</span></div>
      <div><Cloud size={19}/><strong>{publicLabel}</strong><span>Quick Tunnel · HTTPS (OAuth 별도)</span></div>
      <div><LockKeyhole size={19}/><strong>{lockLabel}</strong><span>Tauri 격리 HOME · 수동 잠금 조회</span></div>
    </div>

    {(snapshotError || ownedError) && <div className="diag-error" role="alert">
      <AlertTriangle size={18}/>
      <div><strong>일부 상태를 확인하지 못했습니다.</strong>
        <p>{snapshotError || ownedError}</p>
        {ownedError && snapshotError && <p>{ownedError.slice(0, 340)}</p>}
        <p>서버 소유권을 확인하지 못하면 조작하지 않습니다.</p>
      </div>
    </div>}

    <div className="diag-grid">
      <section className="diag-panel" aria-labelledby="diag-health">
        <div className="diag-panel-heading"><div><Activity size={19}/><h2 id="diag-health">실행 상태·Health</h2></div>
          <span className="diag-pill">{checkedAt ? "마지막 확인 " + checkedAt : "미확인"}</span></div>
        <p>전용 CLI의 <code>status</code>와 <code>health</code>를 조회합니다. 상태 조회는 프로세스를 시작하거나 종료하지 않습니다.</p>
        <div className="diag-facts">
          <div><span>인스턴스</span><strong>{runtime?.name ?? "tauri-preview-v1"}</strong></div>
          <div><span>서버 PID</span><strong>{runtime?.pid ?? "미확인"}</strong></div>
          <div><span>프로세스</span><strong>{runtime ? runtime.alive ? "살아 있음" : "중지" : "미확인"}</strong></div>
          <div><span>로컬 Health</span><strong>{health ? health.healthy ? "정상" : "응답 실패" : "미확인"}</strong></div>
          <div><span>터널 프로세스</span><strong>{health?.tunnelAlive === true ? "실행 중" : health?.tunnelAlive === false ? "중지" : "미확인/없음"}</strong></div>
          <div><span>공개 Health</span><strong>{health?.publicHealthy === true ? "정상" : health?.publicHealthy === false ? "실패" : "확인 대상 아님"}</strong></div>
        </div>
        <div className="diag-actions">
          <button type="button" className="diag-button primary" disabled={!native || isBusy}
            onClick={() => { void refresh(); }}><RefreshCcw size={16}/> 상태 다시 확인</button>
          <button type="button" className="diag-button secondary" onClick={onConnections}>
            MCP 연결 관리 <ArrowRight size={15}/>
          </button>
        </div>
        <p className="diag-note">조회 결과의 PID는 CLI 기록값입니다. 프로세스 소유권이 별도로 검증되지 않으면 조작 근거로 사용하지 않습니다.</p>
      </section>

      <section className="diag-panel" aria-labelledby="diag-doctor">
        <div className="diag-panel-heading"><div><ClipboardList size={19}/><h2 id="diag-doctor">환경 진단 · Doctor</h2></div>
          <span className="diag-pill">읽기 전용</span></div>
        <p>번들 Node, Git, ripgrep, MCP 도구 등록 및 Owner Token 설정 상태를 진단합니다.</p>
        <div className="diag-actions">
          <button type="button" className="diag-button primary" disabled={!native || isBusy}
            onClick={() => { void checkDoctor(); }}>
            <HeartPulse size={16}/> 환경 진단 실행
          </button>
        </div>
        {doctorError && <p className="diag-inline-error" role="alert">{doctorError}</p>}
        <div className="diag-output">
          <pre>{doctor ?? (busy === "doctor" ? "Doctor 실행 중..." : "진단 실행을 누르면 결과가 표시됩니다.")}</pre>
        </div>
        <p className="diag-note">서버 실제 수신 포트는 설정 화면에서 확인하고 변경할 수 있습니다.</p>
      </section>

      <section className="diag-panel" aria-labelledby="diag-logs">
        <div className="diag-panel-heading"><div><TerminalSquare size={19}/><h2 id="diag-logs">실행 로그</h2></div>
          <span className="diag-pill">최근 80줄 · 민감 행 차단</span></div>
        <p>격리된 Tauri 인스턴스의 서버 및 Cloudflare 로그를 확인합니다. 파일 경로나 명령어를 임의 지정하지 않습니다.</p>
        <div className="diag-tabrow" role="group" aria-label="로그 선택">
          <button type="button" className={logTab === "server" ? "selected" : ""}
            aria-pressed={logTab === "server"} disabled={!native || isBusy}
            onClick={() => { void getLogs("server"); }}><FileText size={16}/> 서버 로그</button>
          <button type="button" className={logTab === "tunnel" ? "selected" : ""}
            aria-pressed={logTab === "tunnel"} disabled={!native || isBusy}
            onClick={() => { void getLogs("tunnel"); }}><Cloud size={16}/> 터널 로그</button>
        </div>
        {logError && <p className="diag-inline-error" role="alert">{logError}</p>}
        <div className="diag-output diag-log-output">
          <pre>{busy === "logs" ? "로그 읽는 중..." : logText === null ?
            "로그 종류를 선택하면 최근 기록을 확인합니다." : logText || "출력할 로그가 없습니다."}</pre>
        </div>
        <p className="diag-note">Rust 네이티브 단계에서 민감정보 포함 행을 숨기고 출력량을 제한합니다. MCP 중지 후에도 이전 실행의 로그가 남을 수 있으며, 로그 내용만으로 현재 실행 상태를 판단하지 않습니다. 기록이 없으면 빈 상태로 표시합니다.</p>
      </section>

      <section className="diag-panel" aria-labelledby="diag-locks">
        <div className="diag-panel-heading"><div><LockKeyhole size={19}/><h2 id="diag-locks">프로젝트 작업 잠금</h2></div>
          <span className="diag-pill">{lockLabel}</span></div>
        <p>읽기·쓰기 작업 중인 프로젝트와 소유 PID를 조회합니다. <strong>강제 잠금 해제는 제공하지 않습니다.</strong></p>
        <div className="diag-actions"><button type="button" className="diag-button secondary"
          disabled={!native || isBusy} onClick={() => { void checkLocks(); }}>
          <RefreshCcw size={16}/> 잠금 목록 조회
        </button></div>
        {lockError && <p className="diag-inline-error" role="alert">{lockError}</p>}
        {locks === null ? <div className="diag-empty">잠금 목록을 조회하지 않았거나 확인할 수 없습니다.</div> :
          locks.length === 0 ? <div className="diag-empty"><CheckCircle2 size={18}/> 현재 목록에 활성 잠금이 없습니다.</div> :
            <div className="diag-lock-list">
              {visibleLocks.map((lock, index) => <div className="diag-lock-row" key={lock.projectRoot + index}>
                <strong title={lock.projectRoot}>{lock.projectRoot}</strong>
                <span>{lock.writer ? "쓰기 잠금 · " + lock.writer.owner + " / PID " + (lock.writer.pid ?? "미확인") : "쓰기 잠금 없음"}</span>
                <span>읽기 잠금 {lock.readers.length}개
                  {lock.readers.length ? " · " + lock.readers.map(holder => holder.owner).join(", ").slice(0, 180) : ""}
                </span>
              </div>)}
            </div>}
        {locks && locks.length > 5 && <button type="button" className="diag-text-button"
          onClick={() => setLockExpanded(v => !v)}>{lockExpanded ? "5개만 보기" : "모두 보기 (" + locks.length + "개)"}</button>}
        <p className="diag-note">이 목록은 CLI의 <code>lock list</code> 결과입니다. 조회 시 만료되거나 종료된 잠금 기록을 CLI가 자동 정리할 수 있습니다. 활성 잠금을 강제 해제하거나 PID를 종료하지 않습니다.</p>
      </section>
    </div>

    <section className="diag-panel diag-recovery" aria-labelledby="diag-reload">
      <div className="diag-panel-heading"><div><RotateCcw size={19}/><h2 id="diag-reload">안전한 구성 재로드</h2></div>
        <span className="diag-pill">명시적 확인</span></div>
      <div className="diag-recovery-layout">
        <div><p>실행 중인 전용 MCP의 <strong>프로젝트·실행 환경 구성만</strong> 다시 읽습니다.
          Node 서버 PID, MCP 연결, Cloudflare 터널을 재시작하지 않습니다.</p>
          <p className="diag-note">재로드는 서버 실행 중에만 사용할 수 있습니다. 포트·호스트·터널·Owner Token 변경을 적용하지 않습니다.</p>
        </div>
        <button type="button" className="diag-button secondary"
          disabled={!native || isBusy || !owned?.running} onClick={() => {
            setReloadOpen(true); setReloadError(""); setReloadResult("");
          }}><RotateCcw size={16}/> 구성 재로드</button>
      </div>
      {reloadResult && <p className="diag-success" role="status">{reloadResult.slice(0, 350)}</p>}
      {reloadError && <p className="diag-inline-error" role="alert">{reloadError}</p>}
      <div className="diag-guard"><ShieldCheck size={17}/> 강제 잠금 해제·임의 PID 종료·인스턴스 파일 삭제는 이 화면에서 수행하지 않습니다.
        복구 전 정확한 소유 프로세스와 변경 영향을 확인해야 합니다.</div>
    </section>

    {reloadOpen && <div className="diag-dialog-overlay">
      <section className="diag-dialog" role="dialog" aria-modal="true"
        aria-labelledby="diag-reload-title" aria-describedby="diag-reload-description"
        onKeyDown={event => { if (event.key === "Escape" && busy !== "reload") setReloadOpen(false); }}>
        <div className="diag-dialog-head"><span><RotateCcw size={22}/></span>
          <button type="button" aria-label="닫기" disabled={busy === "reload"} onClick={() => setReloadOpen(false)}><X size={18}/></button>
        </div>
        <h2 id="diag-reload-title">프로젝트·실행 환경 재로드</h2>
        <p id="diag-reload-description">현재 <strong>tauri-preview-v1</strong> 인스턴스의 프로젝트·Python·Docker 구성만 다시 읽습니다.
          실행 중인 작업, MCP 서버, 터널은 종료하지 않습니다.</p>
        {reloadError && <p className="diag-inline-error" role="alert">{reloadError}</p>}
        <div className="diag-dialog-actions">
          <button type="button" className="diag-button secondary" autoFocus
            disabled={busy === "reload"} onClick={() => setReloadOpen(false)}>취소</button>
          <button type="button" className="diag-button primary"
            disabled={!owned?.running || busy !== null} onClick={() => { void reload(); }}>
            {busy === "reload" ? "재로드 중..." : "재로드 실행"}
          </button>
        </div>
      </section>
    </div>}

    <div className="diag-footer"><ShieldCheck size={16}/>
      이 화면은 앱이 소유한 MCP만 진단합니다. 상태 조회는 인증정보를 변경하지 않습니다.
    </div>
  </div>;
}
