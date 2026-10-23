import type { ReactNode } from "react";
import type { CliLogComponent, CliLogPreview, ManagedResult, ManagedAction } from "./runtime";
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

export function ManagementControls({ onConnections, onSettings, onExit, exitError,
  owned, ownedBusy, ownedError, ownedToken, onOwnedAction, onCopyToken }: {
  onConnections: () => void; onSettings: () => void;
  onExit: () => void; exitError: string;
  owned: ManagedResult | null; ownedBusy: boolean; ownedError: string;
  ownedToken: string | null;
  onOwnedAction: (action: ManagedAction) => void;
  onCopyToken: () => void;
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
      <SectionHeading title="프로젝트" icon={<FolderOpen size={18}/>}
        description="작업할 프로젝트 폴더와 CLI 프로필을 선택합니다." />
      <div className="legacy-body">
        <FormRow label="선택된 프로젝트" help="기존 앱의 선택값을 아직 가져오지 않습니다.">
          <div className="legacy-inline"><LockedField placeholder="프로젝트를 선택하지 않았습니다 (미연동)"/><PendingButton label="찾아보기" icon={<FolderOpen size={16}/>} /></div>
        </FormRow>
        <FormRow label="CLI 프로필" help="프로필 목록과 권한 설정은 추후 연결합니다.">
          <select className="legacy-field" disabled aria-label="CLI 프로필 — 연동 예정">
            <option>프로필 연동 예정</option>
          </select>
        </FormRow>
      </div>
    </section>
    <section className="panel page-panel legacy-spaced">
      <SectionHeading title="앱·트레이" icon={<Monitor size={18}/>} status="일부 연결"
        description="작업 표시줄 및 트레이에서의 앱 동작을 관리합니다." />
      <div className="legacy-body">
        <div className="legacy-actions">
          <PendingButton label="트레이로 숨기기" icon={<Monitor size={16}/>} />
          <button type="button" className="legacy-action available" onClick={onExit}><Power size={16}/>앱 종료</button>
        </div>
        <p className="legacy-footnote">앱 종료는 이 프리뷰 창만 닫으며 기존 MCP 서버를 중지하지 않습니다. 트레이 숨기기는 추후 연결합니다.</p>
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

export function LegacyDiagnosticsControls({ onLocalHealth, checking, onPublicHealth, tunnelChecking, tunnelStatus, onViewLogs, logsChecking, logResult }: {
  onLocalHealth: () => void; checking: boolean;
  onPublicHealth: () => void;
  tunnelChecking: boolean;
  tunnelStatus: string;
  onViewLogs: (component: CliLogComponent) => void;
  logsChecking: boolean;
  logResult: CliLogPreview | null;
}) {
  return <section className="panel page-panel legacy-spaced">
    <SectionHeading title="진단 도구" icon={<HeartPulse size={18}/>} status="일부 연결"
      description="기존 Windows 앱의 상태·로그·업데이트 바로가기" />
    <div className="legacy-body">
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
        <PendingButton label="GitHub 저장소 열기" icon={<ExternalLink size={16}/>} />
        <PendingButton label="개발자 정보" icon={<Settings2 size={16}/>} />
      </div>
      <p className="legacy-footnote">공개 Quick Tunnel Health는 독립적으로 검사합니다. 로그는 설치된 CLI 및 기존 WinForms 임시 기록에서 읽으며 민감한 행을 숨깁니다. 업데이트 기능은 아직 연동 예정입니다.</p>
      <p className="legacy-footnote">공개 연결: {tunnelStatus}</p>
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
