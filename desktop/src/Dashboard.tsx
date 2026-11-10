import { useState } from "react";
import {
  Activity, ArrowRight, CircleAlert, ClipboardCopy, Cloud,
  FolderCode, HardDrive, Layers, LockKeyhole, Play, RefreshCcw,
  RotateCw, Settings2, ShieldCheck, Square, TerminalSquare
} from "lucide-react";
import type { CatalogInspection, ManagedAction, ManagedResult, PublicTunnelHealth } from "./runtime";
import { publicView, runtimeView, startAction } from "./dashboard-state";
import "./dashboard.css";

type Destination = "projects" | "manage" | "cli" | "connections" | "diagnostics" | "settings";
interface DashboardProps {
  native: boolean;
  owned: ManagedResult | null;
  ownedBusy: boolean;
  ownedError: string;
  ownedPublicHealth: PublicTunnelHealth | null;
  ownedPublicChecking: boolean;
  publicPreferred: boolean;
  catalog: CatalogInspection | null;
  catalogBusy: boolean;
  catalogError: string;
  onRefreshOwned: () => void;
  onRefreshCatalog: () => void;
  onOwnedAction: (action: ManagedAction) => void;
  onTogglePublic: (enable: boolean) => void;
  onCopyPublic: () => void;
  onNotify: (message: string, tone?: "info" | "error") => void;
  onNavigate: (to: Destination) => void;
}

const runtimeLabels = {
  unsupported: { label: "Windows 앱에서 확인", detail: "Tauri 네이티브 앱에서 실행 상태를 확인할 수 있습니다." },
  checking: { label: "상태 확인 중", detail: "Tauri 전용 CLI 응답을 기다리고 있습니다." },
  unavailable: { label: "CLI 확인 필요", detail: "격리된 번들 런타임의 정상 설치 여부를 확인하세요." },
  setup: { label: "초기 설정 필요", detail: "Owner Token을 준비한 뒤 MCP를 시작할 수 있습니다." },
  stopped: { label: "MCP 중지됨", detail: "전용 서버가 꺼져 있습니다. 필요할 때 시작하세요." },
  online: { label: "MCP 실행 중", detail: "Tauri 전용 MCP 서버를 관리하고 있습니다." }
} as const;

const tunnelLabels = {
  inactive: "외부 공개 안 함",
  unchecked: "외부 상태 확인 중",
  online: "외부 HTTPS 정상",
  offline: "외부 연결 실패",
  unavailable: "외부 확인 불가"
} as const;

export function Dashboard({
  native, owned, ownedBusy, ownedError, ownedPublicHealth,
  ownedPublicChecking, publicPreferred, catalog, catalogBusy, catalogError,
  onRefreshOwned, onRefreshCatalog, onOwnedAction, onTogglePublic, onCopyPublic, onNotify, onNavigate
}: DashboardProps) {
  const runtimeState = runtimeView(native, owned);
  const runtimeLabel = runtimeLabels[runtimeState];
  const tunnelState = publicView(owned, ownedPublicHealth);
  const running = runtimeState === "online";
  // Off: persisted choice for the next start. On: truthful live Cloudflare state.
  const publicEnabled = running ? owned?.tunnelRunning === true : publicPreferred;
  const readyToStart = native && !ownedBusy && owned?.available === true && owned.ready && !running;
  const localEndpoint = "http://127.0.0.1:18797/mcp";
  const canCopyPublic = running && owned?.tunnelRunning === true && !!owned.publicConnector;
  const hasProjects = catalog?.available === true;
  const canToggle = native && !ownedBusy && owned?.available === true && owned.tunnelCapable;
  const publicText = !running
    ? publicPreferred ? "다음 시작 때 Quick Tunnel을 켭니다." : "다음 시작은 로컬 전용입니다."
    : tunnelState === "online" ? "공개 HTTPS Health가 확인됐습니다. OAuth 인증은 별도입니다."
    : tunnelState === "inactive" ? "MCP는 실행 중이며 외부에 공개하지 않았습니다."
    : ownedPublicChecking ? "현재 공개 HTTPS 연결을 자동 확인 중입니다."
    : ownedPublicHealth?.details || "외부 HTTPS 연결을 주기적으로 자동 확인합니다.";

  async function copyLocal() {
    try {
      await navigator.clipboard.writeText(localEndpoint);
      onNotify("로컬 MCP 주소를 복사했습니다.");
    } catch {
      onNotify("주소를 복사하지 못했습니다. 텍스트 필드에서 직접 복사하세요.", "error");
    }
  }

  return <div className="dashboard-root">
    <header className="dash-top">
      <div>
        <p className="dash-eyebrow">C2C DESKTOP / OVERVIEW</p>
        <h1>내 개발 환경</h1>
        <p>로컬 MCP와 외부 공개를 독립적으로 관리하고 프로젝트 상태를 확인합니다.</p>
      </div>
      <button type="button" className="dash-quiet-button" disabled={!native || ownedBusy}
        onClick={() => { onRefreshOwned(); onRefreshCatalog(); }}>
        <RefreshCcw size={16} /> 상태 새로고침
      </button>
    </header>

    <section className="dash-runtime" aria-labelledby="dash-runtime-title">
      <div className="dash-runtime-head">
        <div className="dash-runtime-icon"><TerminalSquare size={22}/></div>
        <div className="dash-runtime-name">
          <p>Tauri 전용 런타임</p>
          <h2 id="dash-runtime-title">ChatGPT To Codex MCP</h2>
          <span>tauri-preview-v1 · 127.0.0.1:18797</span>
        </div>
        <span className={"dash-state dash-state-" + runtimeState} role="status">
          <span className="dash-led" />{runtimeLabel.label}
        </span>
      </div>
      <p className="dash-runtime-desc">{owned?.details || runtimeLabel.detail}</p>
      {ownedError && <div className="dash-error" role="alert"><CircleAlert size={17}/>{ownedError}</div>}
      <div className="dash-actions">
        {runtimeState === "setup" && <button type="button" className="dash-primary"
          onClick={() => onNavigate("manage")}><LockKeyhole size={16}/> 초기 설정</button>}
        {(runtimeState === "stopped" || runtimeState === "online") && <>
          {running ?
            <button type="button" className="dash-primary" disabled={ownedBusy}
              onClick={() => onOwnedAction("stop")}><Square size={16}/> MCP 중지</button> :
            <button type="button" className="dash-primary" disabled={!readyToStart || (publicPreferred && !owned?.tunnelCapable)}
              onClick={() => onOwnedAction(startAction(publicPreferred))}><Play size={16}/> MCP 시작</button>
          }
          {running && <button type="button" className="dash-secondary" disabled={ownedBusy}
            onClick={() => onOwnedAction("restart")}><RotateCw size={16}/> MCP 재시작</button>}
        </>}
        <button type="button" className="dash-text-button" onClick={() => onNavigate("manage")}>
          상세 관리 <ArrowRight size={15}/>
        </button>
      </div>
      <div className="dash-boundary"><ShieldCheck size={15}/> 현재 화면은 Tauri 전용 서버만 조작합니다. 기존 WinForms default:7979는 변경하지 않습니다.</div>
    </section>

    <div className="dash-status-grid">
      <section className="dash-summary dash-summary-external" aria-labelledby="dash-public-title">
        <div className="dash-summary-heading"><Cloud size={17}/><h2 id="dash-public-title">외부 연결 · Cloudflare</h2></div>
        <div className="dash-public-switch-row">
          <div className="dash-public-visual">
            <strong className={"dash-summary-value dash-public-" + tunnelState}>
              {running ? tunnelLabels[tunnelState] : publicEnabled ? "다음 실행에 공개" : "공개 꺼짐"}
            </strong>
            <span className="dash-public-caption">{running && publicEnabled ? "공개 설정 적용됨" : running ? "MCP 로컬 전용" : "다음 실행 시 적용할 설정"}</span>
          </div>
          <button type="button" className={"dash-switch " + (publicEnabled ? "is-on" : "")}
            role="switch" aria-checked={publicEnabled} aria-label="Cloudflare 외부 연결"
            title={running ? "실행 중 전환은 터널과 OAuth 갱신 기능 구현 후 지원합니다." : "다음 MCP 시작 시 적용"}
            disabled={!canToggle} onClick={() => onTogglePublic(!publicEnabled)}>
            <span/>
          </button>
        </div>
        <p>{publicText}</p>
        {canCopyPublic && <div className="dash-endpoint dash-public-endpoint">
          <input value={owned.publicConnector ?? ""} readOnly aria-label="Tauri 전용 공개 MCP URL"/>
          <button type="button" onClick={onCopyPublic} aria-label="공개 MCP URL 복사"><ClipboardCopy size={16}/></button>
        </div>}
        <div className="dash-inline-actions">
          <button type="button" className="dash-card-button" onClick={() => onNavigate("connections")}>
            연결 상세 <ArrowRight size={15}/>
          </button>
        </div>
        {running && publicEnabled && <div className="dash-auto-check" role="status">
          <span className={"dash-led " + (tunnelState === "online" ? "checked" : "")}/>
          {ownedPublicChecking ? "자동 확인 중" : "자동 상태 확인 · 약 30초 간격"}
        </div>}
      </section>
      <section className="dash-summary" aria-labelledby="dash-project-title">
        <div className="dash-summary-heading"><FolderCode size={17}/><h2 id="dash-project-title">등록된 프로젝트</h2></div>
        <strong className="dash-summary-value">{hasProjects ? catalog.projects.length + "개" : "—"}</strong>
        <p>{catalogError || (catalogBusy ? "프로젝트 목록 확인 중..." :
          hasProjects ? "실제 작업 대상은 도구 호출 시 projectId로 지정합니다." : "전용 프로젝트 목록을 확인하지 못했습니다.")}</p>
        <button type="button" className="dash-card-button" onClick={() => onNavigate("projects")}>
          프로젝트 관리 <ArrowRight size={15}/>
        </button>
      </section>
      <section className="dash-summary" aria-labelledby="dash-profile-title">
        <div className="dash-summary-heading"><Layers size={17}/><h2 id="dash-profile-title">실행 환경</h2></div>
        <strong className="dash-summary-value">{hasProjects ? catalog.profiles.length + "개" : "—"}</strong>
        <p>{hasProjects ? "등록된 Python·Docker 프로필입니다." : "전용 CLI 프로필을 확인할 수 없습니다."}</p>
        <button type="button" className="dash-card-button" onClick={() => onNavigate("cli")}>
          프로필 확인 <ArrowRight size={15}/>
        </button>
      </section>
    </div>

    <div className="dash-bottom-grid">
      <section className="dash-panel" aria-labelledby="dash-local-title">
        <div className="dash-panel-title"><HardDrive size={18}/><h2 id="dash-local-title">로컬 연결</h2></div>
        <p>같은 컴퓨터에서만 접근하는 주소입니다. 공개 URL은 위 외부 연결 카드에서 관리합니다.</p>
        <div className="dash-endpoint">
          <input value={localEndpoint} readOnly aria-label="Tauri 전용 로컬 MCP 주소"/>
          <button type="button" onClick={() => { void copyLocal(); }} aria-label="로컬 MCP 주소 복사">
            <ClipboardCopy size={16}/>
          </button>
        </div>
      </section>
      <section className="dash-panel" aria-labelledby="dash-next-title">
        <div className="dash-panel-title"><Activity size={18}/><h2 id="dash-next-title">빠른 작업</h2></div>
        <p>필요한 작업으로 바로 이동합니다. 고급 명령과 복구 기능은 별도 화면에 있습니다.</p>
        <div className="dash-shortcuts">
          <button type="button" onClick={() => onNavigate("diagnostics")}><Activity size={16}/> 진단·로그 <ArrowRight size={14}/></button>
          <button type="button" onClick={() => onNavigate("settings")}><Settings2 size={16}/> 앱 설정 <ArrowRight size={14}/></button>
          <button type="button" onClick={() => onNavigate("projects")}><FolderCode size={16}/> 프로젝트 관리 <ArrowRight size={14}/></button>
        </div>
      </section>
    </div>
  </div>;
}
