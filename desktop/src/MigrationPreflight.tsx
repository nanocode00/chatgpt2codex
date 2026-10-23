import { Archive, CircleAlert, ClipboardCheck, FolderOpen, RefreshCcw, ShieldCheck } from "lucide-react";
import type { LegacyMigrationReport } from "./runtime";

function StateTag({ ok, missing = "확인 불가" }: { ok: boolean; missing?: string }) {
  return <span className={"migration-status " + (ok ? "present" : "")}>{ok ? "확인됨" : missing}</span>;
}

export function MigrationPreflight({ report, busy, error, onInspect, onSnapshot }: {
  report: LegacyMigrationReport | null;
  busy: boolean;
  error: string;
  onInspect: () => void;
  onSnapshot: () => void;
}) {
  return <section className="panel page-panel legacy-spaced" aria-label="WinForms에서 Tauri로 전환 사전 점검">
    <div className="panel-heading">
      <div className="panel-title"><span className="icon-tile"><Archive size={18}/></span>
        <div><h2>WinForms → Tauri 전환 준비</h2>
          <p>기존 설정·연결 정보 조사 · 실제 전환은 아직 비활성화</p>
        </div>
      </div>
      <span className="legacy-pending">사전 점검</span>
    </div>
    <div className="legacy-body">
      <p className="legacy-explanation"><ShieldCheck size={17}/>
        현재 7979 서버를 종료하거나 기존 Owner Token을 재발급하지 않습니다.
        인증 정보의 실제 내용은 읽어서 화면에 표시하지 않습니다.
      </p>
      <div className="legacy-actions">
        <button className="legacy-action available" type="button" disabled={busy}
          onClick={onInspect}><RefreshCcw size={16}/>{busy ? "확인 중..." : "기존 환경 점검"}</button>
        <button className="legacy-action available" type="button" disabled={busy || !report?.settingsFound || report.snapshotSaved}
          onClick={onSnapshot}><ClipboardCheck size={16}/>
          {report?.snapshotSaved ? "설정 스냅샷 저장됨" : "인증정보 제외 설정 스냅샷 저장"}
        </button>
      </div>
      {error && <p className="tunnel-warning" role="alert">{error}</p>}
      {report && <div className="migration-result" aria-live="polite">
        <div className="migration-row"><strong>기존 WinForms 설정</strong><StateTag ok={report.settingsFound}/></div>
        <div className="migration-row"><strong>선택 프로젝트</strong><span>{report.selectedProject || "기록 없음"}
          {report.selectedProject && <StateTag ok={report.projectExists} missing="경로 없음"/>}</span></div>
        <div className="migration-row"><strong>기존 MCP 포트</strong><span>{report.port ?? "설정 없음 (기본 7979)"}
          {report.localPortListening && <StateTag ok={true}/>}</span></div>
        <div className="migration-row"><strong>외부 터널 설정</strong>
          <span>{report.tunnelEnabled === null ? "기록 없음" : report.tunnelEnabled ? "사용" : "미사용"}
            {report.customHostnameConfigured && " · 지정 도메인 있음"}</span></div>
        <div className="migration-row"><strong>Owner Token 해시</strong><StateTag ok={report.ownerHashValid}/></div>
        <div className="migration-row"><strong>OAuth 연결 상태</strong><span>
          <StateTag ok={report.oauthValid}/>
          {report.oauthClientCount !== null && " · 클라이언트 " + report.oauthClientCount + "개"}
        </span></div>
        <div className="migration-row"><strong>Windows 자동 시작 / MCP 자동 시작</strong>
          <span>{report.launchAtStartup === null ? "미확인" : report.launchAtStartup ? "켜짐" : "꺼짐"}
          {" / "}{report.startMcpOnOpen === null ? "미확인" : report.startMcpOnOpen ? "켜짐" : "꺼짐"}</span></div>
        <div className="migration-row"><strong>설정 스냅샷</strong>
          <span>{report.snapshotSaved ? "저장됨 · 인증정보 미포함" : "미생성"}</span></div>
        {report.snapshotPath && <p className="migration-path"><FolderOpen size={14}/> {report.snapshotPath}</p>}
        {report.warnings.map((warning, i) =>
          <p className="migration-warning" key={i}><CircleAlert size={14}/>{warning}</p>)}
      </div>}
      <p className="legacy-footnote">
        이 단계는 전환 가능 여부를 조사하는 작업이며, 실제 인계와 롤백용 전체 백업은 아닙니다.
        기존 Owner Token 해시·OAuth 데이터는 새로운 앱으로 복사하지 않습니다.
        전환하기 전에 별도의 보안 백업과 서버 소유권 이관 검증이 필요합니다.
      </p>
    </div>
  </section>;
}
