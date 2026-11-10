import { useState } from "react";
import {
  Activity, ArrowRight, CircleAlert, CircleCheck, ClipboardCopy, Cloud,
  FolderCode, Globe2, HardDrive, Layers, LockKeyhole, Play, RefreshCcw,
  RotateCw, Settings2, ShieldCheck, Square, TerminalSquare
} from "lucide-react";
import type { CatalogInspection, ManagedAction, ManagedResult, PublicTunnelHealth } from "./runtime";
import { publicView, runtimeView } from "./dashboard-state";
import "./dashboard.css";

type Destination = "manage" | "cli" | "connections" | "diagnostics" | "settings";
interface DashboardProps {
  native: boolean;
  owned: ManagedResult | null;
  ownedBusy: boolean;
  ownedError: string;
  ownedUrlNotice: string;
  ownedPublicHealth: PublicTunnelHealth | null;
  ownedPublicChecking: boolean;
  catalog: CatalogInspection | null;
  catalogBusy: boolean;
  catalogError: string;
  onRefreshOwned: () => void;
  onRefreshCatalog: () => void;
  onOwnedAction: (action: ManagedAction) => void;
  onCheckPublic: () => void;
  onCopyPublic: () => void;
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
  unchecked: "외부 확인 필요",
  online: "외부 HTTPS 정상",
  offline: "외부 연결 실패",
  unavailable: "외부 확인 불가"
} as const;

export function Dashboard({
  native, owned, ownedBusy, ownedError, ownedUrlNotice,
  ownedPublicHealth, ownedPublicChecking, catalog, catalogBusy, catalogError,
  onRefreshOwned, onRefreshCatalog, onOwnedAction, onCheckPublic, onCopyPublic, onNavigate
}: DashboardProps) {
  const [localCopyNote, setLocalCopyNote] = useState("");
  const runtimeState = runtimeView(native, owned);
  const runtimeLabel = runtimeLabels[runtimeState];
  const tunnelState = publicView(owned, ownedPublicHealth);
  const running = runtimeState === "online";
  const readyToStart = native && !ownedBusy && owned?.available === true && owned.ready && !running;
  const localEndpoint = "http://127.0.0.1:18797/mcp";
  const canCopyPublic = owned?.tunnelRunning === true && !!owned.publicConnector;
  const hasProjects = catalog?.available === true;

  async function copyLocal() {
    try {
      await navigator.clipboard.writeText(localEndpoint);
      setLocalCopyNote("로컬 주소를 복사했습니다.");
    } catch {
      setLocalCopyNote("주소를 복사하지 못했습니다. 텍스트 필드에서 직접 복사하세요.");
    }
  }

  return <div className="dashboard-root">
    <header className="dash-top">
      <div>
        <p className="dash-eyebrow">C2C DESKTOP / OVERVIEW</p>
        <h1>내 개발 환경</h1>
        <p>로컬 MCP와 공개 연결을 관리하고, 프로젝트 상태를 빠르게 확인합니다.</p>
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
          <button type="button" className="dash-primary"
            disabled={!readyToStart} onClick={() => onOwnedAction("start")}>
            <Play size={16}/> MCP 시작
          </button>
          <button type="button" className="dash-secondary"
            disabled={!readyToStart || owned?.tunnelCapable !== true}
            onClick={() => onOwnedAction("start-public")}>
            <Globe2 size={16}/> 공개 연결로 시작
          </button>
          <button type="button" className="dash-secondary" disabled={!native || ownedBusy || !running}
            onClick={() => onOwnedAction("stop")}><Square size={15}/> 중지</button>
          <button type="button" className="dash-secondary" disabled={!native || ownedBusy || !running}
            onClick={() => onOwnedAction("restart")}><RotateCw size={15}/> 재시작</button>
        </>}
        <button type="button" className="dash-text-button" onClick={() => onNavigate("manage")}>
          상세 관리 <ArrowRight size={15}/>
        </button>
      </div>
      <div className="dash-boundary"><ShieldCheck size={15}/> 현재 화면은 Tauri 전용 서버만 조작합니다. 기존 WinForms `default:7979`에는 영향을 주지 않습니다.</div>
    </section>

    <div className="dash-status-grid">
      <section className="dash-summary" aria-labelledby="dash-public-title">
        <div className="dash-summary-heading"><Cloud size={17}/><h2 id="dash-public-title">외부 연결</h2></div>
        <strong className={"dash-summary-value dash-public-" + tunnelState}>{tunnelLabels[tunnelState]}</strong>
        <p>{tunnelState === "online" ? "공개 HTTPS Health가 확인됐습니다. ChatGPT OAuth 연결은 별도 확인이 필요합니다." :
          tunnelState === "inactive" ? "외부로 공개하지 않은 상태입니다." :
          ownedPublicHealth?.details || "공개 주소를 검사해 실제 연결 상태를 확인하세요."}</p>
        <div className="dash-inline-actions">
          <button type="button" disabled={!native || ownedPublicChecking || !canCopyPublic}
            onClick={onCheckPublic}><Activity size={14}/> {ownedPublicChecking ? "확인 중..." : "HTTPS 확인"}</button>
          <button type="button" disabled={!canCopyPublic} onClick={onCopyPublic}>
            <ClipboardCopy size={14}/> 주소 복사</button>
        </div>
        {ownedUrlNotice && <p className="dash-feedback" role="status">{ownedUrlNotice}</p>}
      </section>
      <section className="dash-summary" aria-labelledby="dash-project-title">
        <div className="dash-summary-heading"><FolderCode size={17}/><h2 id="dash-project-title">등록된 프로젝트</h2></div>
        <strong className="dash-summary-value">{hasProjects ? catalog.projects.length + "개" : "—"}</strong>
        <p>{catalogError || (catalogBusy ? "프로젝트 목록 확인 중..." :
          hasProjects ? "실제 작업 대상은 도구 호출 시 projectId로 지정합니다." : "전용 프로젝트 목록을 확인하지 못했습니다.")}</p>
        <button type="button" className="dash-card-link" onClick={() => onNavigate("manage")}>
          프로젝트 관리 <ArrowRight size={15}/>
        </button>
      </section>
      <section className="dash-summary" aria-labelledby="dash-profile-title">
        <div className="dash-summary-heading"><Layers size={17}/><h2 id="dash-profile-title">실행 환경</h2></div>
        <strong className="dash-summary-value">{hasProjects ? catalog.profiles.length + "개" : "—"}</strong>
        <p>{hasProjects ? "등록된 Python·Docker 프로필입니다." : "전용 CLI 프로필을 확인할 수 없습니다."}</p>
        <button type="button" className="dash-card-link" onClick={() => onNavigate("cli")}>
          프로필 확인 <ArrowRight size={15}/>
        </button>
      </section>
    </div>

    <div className="dash-bottom-grid">
      <section className="dash-panel" aria-labelledby="dash-local-title">
        <div className="dash-panel-title"><HardDrive size={18}/><h2 id="dash-local-title">로컬 연결</h2></div>
        <p>이 주소는 같은 컴퓨터에서만 접속할 수 있으며 공개 ChatGPT 연결 주소가 아닙니다.</p>
        <div className="dash-endpoint">
          <input value={localEndpoint} readOnly aria-label="Tauri 전용 로컬 MCP 주소"/>
          <button type="button" onClick={() => { void copyLocal(); }} aria-label="로컬 MCP 주소 복사">
            <ClipboardCopy size={16}/>
          </button>
        </div>
        {localCopyNote && <p role="status" className="dash-feedback">{localCopyNote}</p>}
        <button type="button" className="dash-card-link" onClick={() => onNavigate("connections")}>
          연결 상세 <ArrowRight size={15}/>
        </button>
      </section>
      <section className="dash-panel" aria-labelledby="dash-next-title">
        <div className="dash-panel-title"><CircleCheck size={18}/><h2 id="dash-next-title">빠른 작업</h2></div>
        <p>필요한 작업을 선택하세요. 고급 명령과 복구 기능은 별도 화면에 있습니다.</p>
        <div className="dash-shortcuts">
          <button type="button" onClick={() => onNavigate("diagnostics")}><Activity size={16}/> 진단·로그 <ArrowRight size={14}/></button>
          <button type="button" onClick={() => onNavigate("settings")}><Settings2 size={16}/> 앱 설정 <ArrowRight size={14}/></button>
          <button type="button" onClick={() => onNavigate("manage")}><FolderCode size={16}/> MCP·프로젝트 관리 <ArrowRight size={14}/></button>
        </div>
      </section>
    </div>
  </div>;
}
