import type { ReactNode } from "react";
import type { CliLogComponent, CliLogPreview, ManagedResult, ManagedAction, CatalogInspection, PickedRepositoryFolder, PublicTunnelState } from "./runtime";
import {
  ArrowRight, Cloud, Copy, Download, ExternalLink, FileText, FolderOpen,
  Globe2, HeartPulse, KeyRound, Monitor, Play, Power, RefreshCcw,
  RotateCw, Settings2, ShieldCheck, Square, TerminalSquare, Wifi
} from "lucide-react";

function SectionHeading({ title, description, icon, status = "연동 예정" }: {
  title: string; description: string; icon: ReactNode; status?: string;
}) {
  return <div className="panel-heading legacy-heading">
    <div className="panel-title">
      <span className="icon-tile">{icon}</span>
      <div><h2>{title}</h2><p>{description}</p></div>
    </div>
    <span className="legacy-pending">{status}</span>
  </div>;
}

/** Intentionally no callback: unimplemented operations must not mutate state. */
function PendingButton({ label, icon, prominent = false }: {
  label: string; icon?: ReactNode; prominent?: boolean;
}) {
  return <button className={"legacy-action" + (prominent ? " prominent" : "")}
    type="button" disabled aria-label={label + " — 연동 예정"}>
    {icon}{label}
  </button>;
}

function DisabledChoice({ label, description }: { label: string; description: string }) {
  return <div className="legacy-pref-row">
    <div><strong>{label}</strong><p>{description}</p></div>
    <span className="legacy-value">미연동</span>
  </div>;
}

function FormRow({ label, children, help }: {
  label: string; children: ReactNode; help?: string;
}) {
  return <div className="legacy-form-row">
    <div className="legacy-form-label"><strong>{label}</strong>{help && <span>{help}</span>}</div>
    <div className="legacy-form-control">{children}</div>
  </div>;
}

function LockedField({ placeholder = "CLI 설정을 연결한 후 표시됩니다" }: { placeholder?: string }) {
  return <input className="legacy-field" type="text" disabled placeholder={placeholder}
    aria-label={placeholder} />;
}

export function ManagementControls({ onConnections, onSettings, onExit, exitError, onHide, trayError,
  owned, ownedBusy, ownedError, ownedToken, onOwnedAction, onCopyToken,
  catalog, catalogBusy, catalogError, onRefreshCatalog,
  draftRepository, onDraftRepository, selectionBusy, selectionError, selectionNotice, onConfirmRepository,
  pickedFolder, folderBusy, folderName, onFolderName, folderId, onFolderId, folderError, folderNotice,
  onBrowseFolder, onCancelFolder, onRegisterFolder }: {
  onConnections: () => void; onSettings: () => void;
  onExit: () => void; exitError: string;
  onHide: () => void; trayError: string;
  owned: ManagedResult | null; ownedBusy: boolean; ownedError: string;
  ownedToken: string | null;
  onOwnedAction: (action: ManagedAction) => void;
  onCopyToken: () => void;
  catalog: CatalogInspection | null; catalogBusy: boolean; catalogError: string;
  onRefreshCatalog: () => void;
  draftRepository: string; onDraftRepository: (id: string) => void;
  selectionBusy: boolean; selectionError: string; selectionNotice: string;
  onConfirmRepository: () => void;
  pickedFolder: PickedRepositoryFolder | null; folderBusy: boolean;
  folderName: string; onFolderName: (value: string) => void;
  folderId: string; onFolderId: (value: string) => void;
  folderError: string; folderNotice: string;
  onBrowseFolder: () => void; onCancelFolder: () => void; onRegisterFolder: () => void;
}) {
  return <>
    <section className="panel page-panel">
      <SectionHeading title="MCP 서버 제어" icon={<TerminalSquare size={18}/>} status="독립 인스턴스"
        description="검증된 번들 CLI가 만든 별도 로컬 인스턴스만 관리합니다."/>
      <div className="legacy-body">
        <p className="legacy-explanation"><ShieldCheck size={17}/>
          기존 WinForms v0.3.1 서버 (7979)는 그대로 유지합니다.
          이 화면은 격리된 별도 인스턴스 (18797)와 자체 Owner Token만 사용하며,
          Cloudflare 터널은 생성하지 않습니다.
        </p>
        <div className="legacy-owned-status" role="status">
          <strong>{owned?.available
            ? owned.running ? "전용 MCP Online" : owned.ready ? "전용 MCP 중지됨" : "전용 MCP 초기 설정 필요"
            : "번들 CLI 확인 필요"}</strong>
          <p>{owned?.details ?? "전용 CLI 상태를 확인하고 있습니다."}</p>
          <small>인스턴스: tauri-preview-v1 · 로컬 주소: http://127.0.0.1:18797/mcp</small>
        </div>
        <div className="legacy-actions large">
          <button className="legacy-action available" type="button" onClick={() => onOwnedAction("status")} disabled={ownedBusy}>
            <RefreshCcw size={16}/>{ownedBusy ? "작업 중..." : "상태 조회"}
          </button>
          <button className="legacy-action available" type="button" onClick={() => onOwnedAction("prepare")} disabled={ownedBusy || !owned?.available || owned.ready}>
            <KeyRound size={16}/>전용 인스턴스 준비
          </button>
          <button className="legacy-action available" type="button" onClick={() => onOwnedAction("start")} disabled={ownedBusy || !owned?.ready || owned.running}>
            <Play size={17}/>MCP 시작
          </button>
          <button className="legacy-action available" type="button" onClick={() => onOwnedAction("stop")} disabled={ownedBusy || !owned?.running}>
            <Square size={17}/>MCP 중지
          </button>
          <button className="legacy-action available" type="button" onClick={() => onOwnedAction("restart")} disabled={ownedBusy || !owned?.running}>
            <RotateCw size={17}/>MCP 재시작
          </button>
        </div>
        {ownedError && <p className="tunnel-warning" role="alert">{ownedError}</p>}
        {ownedToken && <div className="legacy-token-notice" role="status">
          <strong>전용 Owner Token이 생성됐습니다 (최초 1회 표시)</strong>
          <p>기존 WinForms 토큰과 무관합니다. 화면에 내용을 그대로 표시하지 않으며,
            복사하면 앱 내 임시 값은 즉시 지워집니다.</p>
          <button className="legacy-action available" type="button" onClick={onCopyToken}>
            <Copy size={16}/>새 토큰 복사 및 화면에서 지우기
          </button>
        </div>}
        <p className="legacy-footnote">버튼은 CLI 소유권 검증에 실패하면 작동하지 않습니다. 전용 포트가 이미 사용 중이면 다른 프로세스를 종료하지 않습니다.</p>
        <button type="button" className="text-action legacy-link" onClick={onConnections}>
          기존 WinForms CLI 상태 조회로 이동 <ArrowRight size={16}/>
        </button>
      </div>
    </section>
    <section className="panel page-panel legacy-spaced">
      <SectionHeading title="프로젝트·CLI 프로필" icon={<FolderOpen size={18}/>} status="전용 프로젝트 선택"
        description="기존 WinForms는 조회만 하고 Tauri 전용 프로젝트만 확인 후 선택합니다." />
      <div className="legacy-body">
        <div className="legacy-actions">
          <button className="legacy-action available" type="button" disabled={catalogBusy}
            onClick={onRefreshCatalog}>
            <RefreshCcw size={16}/>{catalogBusy ? "조회 중..." : "목록 새로고침"}
          </button>
        </div>
        {catalogError && <p className="form-error" role="alert">{catalogError}</p>}
        <FormRow label="기존 WinForms 선택 프로젝트" help="기존 설정을 읽기만 합니다. 아래 독립 CLI 목록과 연결되지 않습니다.">
          <input className="legacy-field" type="text" readOnly
            value={catalog?.legacyProject ?? ""}
            placeholder={catalog ? "선택된 프로젝트 없음" : "조회 전"}
            aria-label="기존 WinForms 프로젝트 경로 (조회 전용)" />
        </FormRow>
        {catalog?.legacyProject && <p className="legacy-footnote" role="status">
          {catalog.legacyProjectExists ? "기존 프로젝트 디렉터리 확인됨" : "기존 프로젝트 디렉터리를 찾지 못했습니다."}
        </p>}
        <div className="legacy-pref-row">
          <div><strong>Tauri 전용 프로젝트 목록</strong>
            <p>격리된 프리뷰 HOME에 등록된 프로젝트입니다. 기존 WinForms 프로젝트를 자동으로 가져오지 않습니다.</p>
          </div>
          <span className="legacy-value">{catalog?.available ? catalog.projects.length + "개" : "확인 필요"}</span>
        </div>
        {catalog?.available && (catalog.projects.length
          ? <ul aria-label="Tauri 전용 프로젝트 목록">
              {catalog.projects.map(item => <li key={item.id}>
                <strong>{item.name}</strong> ({item.id}) · {item.available ? "디렉터리 확인됨" : "디렉터리 없음"}
              </li>)}
            </ul>
          : <p className="legacy-footnote">등록된 전용 프로젝트가 없습니다.</p>)}
        <div className="legacy-pref-row">
          <div><strong>프로젝트 폴더 등록</strong>
            <p>Windows 폴더 선택기를 사용합니다. 등록은 Tauri 전용 목록에만 저장되고 기존 서버는 변경하지 않습니다.</p>
          </div>
          <button type="button" className="legacy-action available" onClick={onBrowseFolder}
            disabled={!catalog?.available || !!owned?.running || ownedBusy || selectionBusy || folderBusy || catalogBusy}>
            <FolderOpen size={16}/>{folderBusy ? "작업 중..." : "폴더 찾아보기"}
          </button>
        </div>
        {pickedFolder && <div className="legacy-register-preview">
          <p className="legacy-footnote">선택한 폴더를 확인하고 이름과 ID를 지정하세요. 등록 전에는 아무 설정도 저장하지 않습니다.</p>
          <FormRow label="선택된 폴더">
            <input className="legacy-field" value={pickedFolder.path} readOnly aria-label="선택한 프로젝트 경로" />
          </FormRow>
          <FormRow label="프로젝트 이름">
            <input className="legacy-field" value={folderName} maxLength={160}
              onChange={e => onFolderName(e.target.value)} aria-label="등록할 프로젝트 이름" disabled={folderBusy}/>
          </FormRow>
          <FormRow label="프로젝트 ID" help="영문 소문자와 숫자로 시작하며 영문 소문자·숫자·점·밑줄·하이픈만 사용할 수 있습니다.">
            <input className="legacy-field" value={folderId} maxLength={64}
              onChange={e => onFolderId(e.target.value)} aria-label="등록할 프로젝트 ID" disabled={folderBusy}/>
          </FormRow>
          <div className="legacy-actions">
            <button className="legacy-action available" type="button" onClick={onRegisterFolder}
              disabled={folderBusy || ownedBusy || selectionBusy || !!owned?.running}>등록 확인</button>
            <button className="legacy-action available" type="button" onClick={onCancelFolder}
              disabled={folderBusy}>취소</button>
          </div>
        </div>}
        {folderError && <p className="form-error" role="alert">{folderError}</p>}
        {folderNotice && <p className="form-ok" role="status">{folderNotice}</p>}
        <FormRow label="다음 시작에 사용할 Tauri 전용 프로젝트" help="등록된 프로젝트 중 디렉터리가 확인된 항목만 선택합니다. 확인 후 저장되며 실행 중인 서버는 변경되지 않습니다.">
          <div className="legacy-inline">
            <select className="legacy-field" aria-label="Tauri 전용 프로젝트 선택" value={draftRepository}
              onChange={event => onDraftRepository(event.target.value)}
              disabled={!catalog?.available || catalogBusy || selectionBusy || ownedBusy || !!owned?.running}>
              <option value="">기본 격리된 프리뷰 작업 공간</option>
              {catalog?.projects.filter(item => item.available).map(item => (
                <option key={item.id} value={item.id}>{item.name} ({item.id})</option>
              ))}
            </select>
            <button className="legacy-action available" type="button" onClick={onConfirmRepository}
              disabled={!catalog?.available || draftRepository === (catalog.selectedRepository ?? "") ||
                (draftRepository !== "" && !catalog.projects.some(item => item.id === draftRepository && item.available)) ||
                catalogBusy || selectionBusy || ownedBusy || !!owned?.running}>
              {selectionBusy ? "저장 중..." : "선택 확인 및 저장"}
            </button>
          </div>
        </FormRow>
        <p className="legacy-footnote" role="status">현재 설정: {catalog?.selectedRepository
          ? catalog.projects.find(item => item.id === catalog.selectedRepository)?.name ?? catalog.selectedRepository
          : "기본 격리 작업 공간"} · 인스턴스 tauri-preview-v1:18797 전용</p>
        {selectionError && <p className="form-error" role="alert">{selectionError}</p>}
        {selectionNotice && <p className="form-ok" role="status">{selectionNotice}</p>}
        <p className="legacy-footnote">등록과 선택은 별개의 작업입니다. 실행 중인 전용 서버나 기록이 남은 인스턴스에서는 변경을 거부하며, 자동 재시작하지 않습니다. 프로젝트 삭제는 아직 CLI에서만 지원합니다.</p>
        <div className="legacy-pref-row">
          <div><strong>Tauri 전용 CLI 프로필</strong>
            <p>Python/Docker 프로필은 조회 전용입니다. CLI에는 활성 프로필을 고르는 별도의 use 명령이 없어 적용 기능은 아직 제공하지 않습니다.</p>
          </div>
          <span className="legacy-value">{catalog?.available ? catalog.profiles.length + "개" : "확인 필요"}</span>
        </div>
        {catalog?.available && (catalog.profiles.length
          ? <ul aria-label="Tauri 전용 CLI 프로필 목록">
              {catalog.profiles.map(item => <li key={item.alias}>
                <strong>{item.alias}</strong> · {[item.python && "Python", item.docker && "Docker"].filter(Boolean).join(" / ")}
              </li>)}
            </ul>
          : <p className="legacy-footnote">등록된 전용 프로필이 없습니다.</p>)}
        <p className="legacy-footnote" role="status">{catalog?.details ?? "읽기 전용 목록 조회를 시작하지 않았습니다."}</p>
        <p className="legacy-footnote">전용 프로젝트 선택은 등록된 항목에만 적용됩니다. 기존 WinForms 설정과 서버 7979 및 CLI 프로필 설정은 변경하지 않습니다.</p>
      </div>
    </section>
    <section className="panel page-panel legacy-spaced">
      <SectionHeading title="앱·트레이" icon={<Monitor size={18}/>} status="연결됨"
        description="작업 표시줄 및 트레이에서의 앱 동작을 관리합니다." />
      <div className="legacy-body">
        <div className="legacy-actions">
          <button type="button" className="legacy-action available" onClick={onHide}><Monitor size={16}/>트레이로 숨기기</button>
          <button type="button" className="legacy-action available" onClick={onExit}><Power size={16}/>앱 종료</button>
        </div>
        <p className="legacy-footnote">트레이로 숨기면 Tauri 창만 사라지며 트레이 메뉴나 아이콘 더블클릭으로 복원할 수 있습니다. 앱 종료는 Tauri 프리뷰만 끝내며 기존 MCP 서버를 중지하지 않습니다.</p>
        {trayError && <p role="alert" className="form-error">{trayError}</p>}
        {exitError && <p role="alert" className="form-error">{exitError}</p>}
        <button type="button" className="text-action legacy-link" onClick={onSettings}>
          시작 옵션 및 설정 보기 <ArrowRight size={16}/>
        </button>
      </div>
    </section>
  </>;
}

export function LegacyConnectionControls({ publicConnector, publicState, publicVerified, publicOffline, publicNotice, onCopyPublic, onRefreshPublic, publicCopied, checking }: {
  publicConnector: string | null;
  publicState: string;
  publicVerified: boolean;
  publicOffline: boolean;
  publicNotice: string;
  onCopyPublic: () => void;
  onRefreshPublic: () => void;
  publicCopied: boolean;
  checking: boolean;
}) {
  return <>
    <section className="panel page-panel legacy-spaced">
      <SectionHeading title="외부 ChatGPT 연결" icon={<Cloud size={18}/>} status="일부 연결"
        description="Cloudflare Quick Tunnel / Named Tunnel 구성" />
      <div className="legacy-body">
        <DisabledChoice label="ChatGPT 웹 커넥터 사용" description="활성화 여부와 실제 터널 상태는 CLI 통합 후 조회합니다."/>
        <FormRow label="본인 소유 고정 도메인 (선택)" help="빈 값일 때 Quick Tunnel을 사용하던 기존 설정을 이관할 예정입니다.">
          <LockedField placeholder="터널 설정을 조회하지 않았습니다"/>
        </FormRow>
        <div className={"tunnel-status " + (publicVerified ? "healthy" : publicOffline ? "unreachable" : "")} role="status">
          <Globe2 size={17}/>
          <div><strong>{publicVerified ? "공개 터널 정상" : publicOffline ? "공개 터널 연결 실패" : "공개 연결 미확인"}</strong>
            <p>{publicState}</p>
          </div>
        </div>
        {publicNotice && <p className="tunnel-warning" role="alert">{publicNotice}</p>}
        <FormRow label="공개 커넥터 URL" help={publicOffline ? "해당 주소로 현재 외부 연결이 확인되지 않습니다. 재연결 뒤 다시 조회하세요." : publicState}>
          <input className="legacy-field" type="text" readOnly
            value={publicConnector ?? ""} placeholder="CLI에서 확인된 공개 주소 없음"
            aria-label="CLI에서 확인한 공개 MCP 주소" />
        </FormRow>
        <div className="legacy-actions">
          <button type="button" className="legacy-action available" onClick={onRefreshPublic} disabled={checking}>
            <Globe2 size={16}/>{checking ? "조회 중..." : "공개 상태 확인"}
          </button>
          <button type="button" className="legacy-action available" onClick={onCopyPublic} disabled={!publicConnector || publicOffline}>
            <Copy size={16}/>{publicCopied ? "복사 완료" : "공개 커넥터 URL 복사"}
          </button>
        </div>
        <p className="legacy-footnote">공개 상태는 로컬 Health와 별도로 Quick Tunnel의 HTTPS /healthz를 직접 검사합니다. 절전 복귀 후 자동 재검사하지만 터널을 시작·종료하거나 ChatGPT의 주소를 자동 변경하지 않습니다.</p>
      </div>
    </section>
    <section className="panel page-panel legacy-spaced">
      <SectionHeading title="Owner Token" icon={<KeyRound size={18}/>}
        description="MCP 연결 승인에 사용하는 비밀 토큰 관리" />
      <div className="legacy-body">
        <FormRow label="소유자 토큰" help="기존 토큰을 이 앱으로 가져오거나 저장하지 않습니다.">
          <input className="legacy-field" type="password" disabled value="" placeholder="토큰 미조회 — 기존 값은 유지됩니다"
            aria-label="소유자 토큰 미조회" readOnly />
        </FormRow>
        <div className="legacy-actions">
          <PendingButton label="소유자 토큰 복사" icon={<Copy size={16}/>} />
          <PendingButton label="토큰 자동 생성" icon={<KeyRound size={16}/>} />
        </div>
        <p className="legacy-footnote">토큰을 새로 생성하면 기존 OAuth 연결이 무효화될 수 있습니다. 기능 연결 시 명시적인 확인 절차를 추가합니다.</p>
      </div>
    </section>
  </>;
}

export function LegacyDiagnosticsControls({ onLocalHealth, checking, onPublicHealth, tunnelChecking, tunnelStatus, onViewLogs, logsChecking, logResult,
  native, localVerified, localChecked, localDetails, localPort, publicVerified, publicHealthState, openError,
  onOpenLocalHealth, onOpenPublicHealth, onOpenGithub, onOpenDeveloper }: {
  onLocalHealth: () => void; checking: boolean;
  onPublicHealth: () => void;
  tunnelChecking: boolean;
  tunnelStatus: string;
  onViewLogs: (component: CliLogComponent) => void;
  logsChecking: boolean;
  logResult: CliLogPreview | null;
  native: boolean; localVerified: boolean; localChecked: boolean; localDetails: string; localPort: number;
  publicVerified: boolean; publicHealthState: PublicTunnelState | null; openError: string;
  onOpenLocalHealth: () => void; onOpenPublicHealth: () => void;
  onOpenGithub: () => void; onOpenDeveloper: () => void;
}) {
  return <section className="panel page-panel legacy-spaced">
    <SectionHeading title="진단 도구" icon={<HeartPulse size={18}/>} status="일부 연결"
      description="로컬 서버와 외부 연결을 확인하고 로그를 살펴봅니다." />
    <div className="legacy-body">
      <div className="legacy-health-summary" aria-label="연결 상태 요약">
        <div className="legacy-pref-row" role="status">
          <div>
            <strong>로컬 MCP 서버 · 127.0.0.1:{localPort}</strong>
            <p>{localDetails}</p>
          </div>
          <span className="legacy-value">{!native ? "네이티브 앱 필요" : !localChecked ? "확인 중" : localVerified ? "정상" : "미연결"}</span>
        </div>
        <div className="legacy-pref-row" role="status">
          <div>
            <strong>외부 공개 연결 · Quick Tunnel</strong>
            <p>{tunnelStatus}</p>
          </div>
          <span className="legacy-value">{!native ? "네이티브 앱 필요" : publicHealthState === "online" ? "정상" : publicHealthState === "offline" ? "연결 실패" : publicHealthState === "unsupported" ? "직접 검사 미지원" : "미확인"}</span>
        </div>
      </div>
      <div className="legacy-actions">
        <button type="button" className="legacy-action available" onClick={onLocalHealth} disabled={checking}>
          <Wifi size={16}/>{checking ? "확인 중..." : "로컬 상태 확인"}
        </button>
        <button type="button" className="legacy-action available" onClick={onPublicHealth} disabled={tunnelChecking}>
          <Globe2 size={16}/>{tunnelChecking ? "확인 중..." : "공개 상태 확인"}
        </button>
        <button type="button" className="legacy-action available" onClick={() => onViewLogs("server")} disabled={logsChecking}>
          <FileText size={16}/>{logsChecking ? "읽는 중..." : "서버 로그 보기"}
        </button>
        <button type="button" className="legacy-action available" onClick={() => onViewLogs("tunnel")} disabled={logsChecking}>
          <FileText size={16}/>터널 로그 보기
        </button>
        <PendingButton label="업데이트 확인" icon={<Download size={16}/>} />
        <button type="button" className="legacy-action available" onClick={onOpenGithub} disabled={!native}>
          <ExternalLink size={16}/>GitHub 저장소 열기
        </button>
        <button type="button" className="legacy-action available" onClick={onOpenDeveloper} disabled={!native}>
          <Settings2 size={16}/>개발자 정보
        </button>
      </div>
      <p className="legacy-footnote">Health는 서비스가 정상인지 확인하는 기능입니다. 위 상태는 앱에서 읽기 쉽게 표시하며, 업데이트 확인은 아직 미연결입니다.</p>
      <details className="legacy-health-advanced">
        <summary>고급 진단 · 서버 응답 JSON 보기</summary>
        <p className="legacy-footnote">아래 링크는 일반 웹페이지가 아니라 개발자·운영자용 <code>/healthz</code> API 원본입니다. 기본 브라우저에서 JSON 텍스트가 표시되는 것이 정상입니다. 링크는 클릭 시 다시 검증합니다.</p>
        <div className="legacy-actions">
          <button type="button" className="legacy-action available" onClick={onOpenLocalHealth} disabled={!native || !localVerified}>
            <ExternalLink size={16}/>로컬 응답 JSON
          </button>
          <button type="button" className="legacy-action available" onClick={onOpenPublicHealth} disabled={!native || !publicVerified}>
            <ExternalLink size={16}/>공개 응답 JSON
          </button>
        </div>
      </details>
      {openError && <p className="form-error" role="alert">{openError}</p>}
      {logResult && <div className="legacy-log-viewer" role="region" aria-label="C2C CLI 로그 미리보기">
        <div className="legacy-log-caption">{logResult.component === "server" ? "서버 로그" : "터널 로그"} · {logResult.details}</div>
        {logResult.available && logResult.content
          ? <pre>{logResult.content}</pre>
          : <p className="legacy-footnote">{logResult.details}</p>}
        {logResult.truncated && <p className="legacy-footnote">최신 내용 일부만 표시하고 있습니다.</p>}
      </div>}
    </div>
  </section>;
}

export function LegacySettingsControls() {
  return <section className="panel page-panel legacy-spaced">
    <SectionHeading title="Windows 런처 설정" icon={<Settings2 size={18}/>}
      description="기존 WinForms 설정 항목 · CLI 연동 후 사용 가능" />
    <div className="legacy-body">
      <p className="legacy-explanation"><ShieldCheck size={17}/>
        이 항목들은 기존 Windows 설치본의 실제 설정값을 읽어오지 않았습니다.
        아래 상태는 사용 중인 설정을 의미하지 않으며 수정하거나 저장할 수 없습니다.
      </p>
      <FormRow label="언어">
        <select className="legacy-field" disabled aria-label="언어 — 연동 예정"><option>Auto (System) — 연동 예정</option></select>
      </FormRow>
      <DisabledChoice label="Windows 시작 시 ChatGPT To Codex 실행" description="시작프로그램 등록 상태 및 변경 기능"/>
      <DisabledChoice label="앱 실행 시 MCP 자동 시작" description="앱과 서버의 시작 정책"/>
      <DisabledChoice label="업데이트 자동 확인" description="앱 업데이트 조회 및 알림"/>
      <FormRow label="MCP 서버 포트" help="아래 값은 서버 포트 설정이 아닙니다. 모니터링 포트는 위 카드에서 별도 관리합니다.">
        <LockedField placeholder="서버 설정 조회 후 표시됩니다"/>
      </FormRow>
      <FormRow label="GitHub 저장소 URL">
        <LockedField placeholder="기존 앱의 저장소 설정 조회 후 표시됩니다"/>
      </FormRow>
      <div className="legacy-actions">
        <PendingButton label="런처 설정 저장" icon={<Settings2 size={16}/>} />
        <PendingButton label="업데이트 확인" icon={<RefreshCcw size={16}/>} />
      </div>
      <p className="legacy-footnote">기존 앱의 설정 파일, Owner Token, Windows 시작프로그램 등록 정보를 변경하지 않습니다.</p>
    </div>
  </section>;
}
