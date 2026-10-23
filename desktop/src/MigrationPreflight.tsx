import { Archive, CircleAlert, ClipboardCheck, FolderOpen, RefreshCcw, ShieldCheck } from "lucide-react";
import type { CredentialBackupReport, LegacyMigrationReport, RestoreRehearsalReport } from "./runtime";

function StateTag({ ok, missing = "확인 불가" }: { ok: boolean; missing?: string }) {
  return <span className={"migration-status " + (ok ? "present" : "")}>{ok ? "확인됨" : missing}</span>;
}

export function MigrationPreflight({ report, busy, error, onInspect, onSnapshot, backup, backupBusy, backupError, onBackup, onVerifyBackup, rehearsal, rehearsalBusy, rehearsalError, onRehearse }: {
  report: LegacyMigrationReport | null;
  busy: boolean;
  error: string;
  onInspect: () => void;
  onSnapshot: () => void;
  backup: CredentialBackupReport | null;
  backupBusy: boolean;
  backupError: string;
  onBackup: () => void;
  onVerifyBackup: () => void;
  rehearsal: RestoreRehearsalReport | null;
  rehearsalBusy: boolean;
  rehearsalError: string;
  onRehearse: () => void;
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
      <div className="migration-backup-card">
        <div className="migration-backup-title"><ShieldCheck size={18}/>
          <div><strong>인증정보 암호화 백업</strong>
            <p>Owner Token 해시와 OAuth 기록을 Windows 현재 사용자 계정의 DPAPI로 암호화합니다.</p>
          </div>
        </div>
        <p className="migration-backup-description">
          생성 버튼을 누를 때만 기존 설정·Owner Token 해시·OAuth 데이터를 읽습니다.
          백업 내용은 화면에 노출하지 않으며 원본을 수정하지 않습니다.
          생성 이후에는 복호화·체크섬·형식을 검사해 검증합니다.
        </p>
        <div className="legacy-actions">
          <button className="legacy-action available" type="button"
            disabled={backupBusy || !report?.ownerHashValid || !report?.oauthValid || !report?.settingsFound || backup?.exists}
            onClick={onBackup}><Archive size={16}/>
            {backupBusy ? "작업 중..." : backup?.exists ? "암호화 백업 존재" : "인증정보 보안 백업 생성"}
          </button>
          <button className="legacy-action available" type="button" disabled={backupBusy || !backup?.exists}
            onClick={onVerifyBackup}><RefreshCcw size={16}/>백업 복호화·무결성 재검사</button>
        </div>
        {backupError && <p className="tunnel-warning" role="alert">{backupError}</p>}
        <p className="migration-backup-description" role="status">
          {backup?.verified ? "현재 Windows 사용자 계정으로 복호화·무결성 검사 통과" : backup?.exists ? "백업이 있으나 검증되지 않았습니다" : "암호화 백업을 만들지 않았습니다"}
          {backup?.verified && backup.oauthClients !== null ? " · OAuth 클라이언트 " + backup.oauthClients + "개" : ""}
        </p>
        {backup?.path && <p className="migration-path"><FolderOpen size={14}/>{backup.path}</p>}
        <div className="migration-rehearsal">
          <strong>격리 복원 리허설</strong>
          <p>기존 서버를 멈추지 않고 암호화 백업을 격리된 임시 폴더에서 복원·재검증합니다.
            임시 폴더에는 DPAPI 암호문만 저장하며 평문 인증 파일은 기록하지 않습니다.</p>
          <button className="legacy-action available" type="button"
            onClick={onRehearse} disabled={rehearsalBusy || !backup?.verified}>
            <RefreshCcw size={16}/>{rehearsalBusy ? "복원 검증 중..." : "격리 복원 리허설 실행"}
          </button>
          {rehearsalError && <p className="tunnel-warning" role="alert">{rehearsalError}</p>}
          {rehearsal && <p className="migration-rehearsal-result" role="status">
            {rehearsal.passed ? "복원 리허설 통과" : "복원 리허설 미통과"} · 검증 파일 {rehearsal.restoredFiles}개
            · OAuth 클라이언트 {rehearsal.oauthClients}개
            · 임시 폴더 {rehearsal.temporaryDirectoryRetained ? "잔존" : "정리 완료"}
            <span>{rehearsal.details}</span>
          </p>}
        </div>
        <p className="legacy-footnote">
          백업은 이 Windows 로그인 환경에 묶여 있으며 서버 중지 시점의 일관성을 보장하지 않습니다.
          디스크 오류·Windows 계정 손실 시 복원할 수 있다는 보증이 아니고,
          서버 전환이나 원본 파일에 실제 복원하는 기능은 아직 없습니다.
        </p>
      </div>
      <p className="legacy-footnote">
        이 단계는 전환 가능 여부를 조사하는 작업이며, 실제 인계와 롤백용 전체 백업은 아닙니다.
        기존 Owner Token 해시·OAuth 데이터는 새로운 앱으로 복사하지 않습니다.
        전환하기 전에 별도의 보안 백업과 서버 소유권 이관 검증이 필요합니다.
      </p>
    </div>
  </section>;
}
