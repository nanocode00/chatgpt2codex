import type { FormEvent } from "react";
import {
  Activity, HardDrive, LockKeyhole, Power,
  RefreshCcw, ShieldCheck, Square, X
} from "lucide-react";
import type { PreviewStartupInspection, RuntimeHealth } from "./runtime";
import "./settings-screen.css";

interface SettingsScreenProps {
  native: boolean;
  port: number;
  draftPort: string;
  onDraftPort: (value: string) => void;
  onSavePort: (event: FormEvent<HTMLFormElement>) => void;
  autoRefresh: boolean;
  onAutoRefresh: (enabled: boolean) => void;
  monitorStatus: RuntimeHealth | null;
  settingError: string;
  settingsNotice: string;
  previewStartup: PreviewStartupInspection | null;
  startupBusy: boolean;
  startupError: string;
  onRefreshStartup: () => void;
  onToggleStartup: (enabled: boolean) => void;
  exitBusy: boolean;
  ownedBusy: boolean;
  exitError: string;
  trayError: string;
  onHide: () => void;
  onExitApp: () => void;
  onExitAll: () => void;
}

export function SettingsScreen({
  native, port, draftPort, onDraftPort, onSavePort, autoRefresh,
  onAutoRefresh, monitorStatus, settingError, settingsNotice, previewStartup,
  startupBusy, startupError, onRefreshStartup, onToggleStartup,
  exitBusy, ownedBusy, exitError, trayError, onHide, onExitApp, onExitAll
}: SettingsScreenProps) {
  const targetName = port === 18797 ? "Tauri 전용 MCP" : "사용자 지정";
  const canExit = native && !exitBusy && !ownedBusy;

  return <div className="settings-screen">
    <header className="settings-heading">
      <div><p className="eyebrow">APP PREFERENCES</p><h1>설정</h1>
        <p>Windows 앱의 실행 방식과 상태 조회를 관리합니다. 서버 구성과 인증은 이 화면에서 변경하지 않습니다.</p></div>
    </header>

    <div className="settings-grid">
      <section className="panel settings-card" aria-labelledby="settings-startup">
        <div className="settings-card-heading">
          <span className="icon-tile"><Power size={18}/></span>
          <div><h2 id="settings-startup">Windows 자동 시작</h2>
            <p>현재 사용자 계정에 등록하는 Tauri 앱 전용 옵션</p></div>
        </div>
        <div className="settings-option">
          <div><strong>로그인할 때 앱 실행</strong>
            <p>{previewStartup?.details ?? (native ? "자동 시작 등록 상태를 확인하고 있습니다." : "Windows 설치형 앱에서만 사용할 수 있습니다.")}</p></div>
          <button type="button" className={"switch " + (previewStartup?.enabled ? "enabled" : "")}
            role="switch" aria-label="Tauri 로그인 자동 시작"
            aria-checked={previewStartup?.enabled ?? false}
            disabled={!native || !previewStartup?.supported || !!previewStartup.conflict || startupBusy}
            onClick={() => onToggleStartup(!previewStartup?.enabled)}><span /></button>
        </div>
        <div className="settings-card-footer">
          <span>휴대용 ZIP에서는 등록 변경 불가 · MCP 자동 시작과 별개</span>
          <button type="button" className="secondary-btn" disabled={!native || startupBusy}
            onClick={onRefreshStartup}><RefreshCcw size={14}/> 등록 상태 확인</button>
        </div>
        {previewStartup?.conflict && <p className="settings-warning" role="alert">기존 등록과 충돌이 감지됐습니다. 자동 시작을 변경하지 않고 상태를 확인하세요.</p>}
        {startupError && <p className="form-error" role="alert">{startupError}</p>}
      </section>

      <section className="panel settings-card" aria-labelledby="settings-monitor">
        <div className="settings-card-heading">
          <span className="icon-tile"><Activity size={18}/></span>
          <div><h2 id="settings-monitor">상태 모니터링</h2>
            <p>상태 조회 대상만 변경하며 서버 수신 포트는 바꾸지 않습니다.</p></div>
        </div>
        <form className="settings-monitor-form" onSubmit={onSavePort}>
          <label htmlFor="settings-monitor-port">조회할 localhost 포트</label>
          <div className="settings-presets">
            <button type="button" aria-pressed={draftPort === "18797"}
              onClick={() => onDraftPort("18797")}>Tauri 전용 · 18797</button>
          </div>
          <div className="settings-port-row">
            <input id="settings-monitor-port" inputMode="numeric" type="number" min="1" max="65535"
              value={draftPort} onChange={event => onDraftPort(event.target.value)}/>
            <button className="secondary-btn" type="submit">조회 포트 저장</button>
          </div>
          <p className="settings-support">현재 적용: {targetName} · 127.0.0.1:{port}</p>
          <p className="settings-support">조회 결과: {monitorStatus?.details ?? "아직 확인하지 않았습니다."}</p>
          {settingError && <p className="form-error" role="alert">{settingError}</p>}
          {settingsNotice && <p className="form-ok" role="status">{settingsNotice}</p>}
        </form>
        <div className="settings-option">
          <div><strong>자동 상태 확인</strong><p>앱이 열려 있는 동안 10초 간격으로 선택한 포트를 확인합니다.</p></div>
          <button type="button" className={"switch " + (autoRefresh ? "enabled" : "")}
            role="switch" aria-label="자동 상태 확인" aria-checked={autoRefresh}
            onClick={() => onAutoRefresh(!autoRefresh)}><span /></button>
        </div>
      </section>

      <section className="panel settings-card settings-wide" aria-labelledby="settings-lifecycle">
        <div className="settings-card-heading">
          <span className="icon-tile"><HardDrive size={18}/></span>
          <div><h2 id="settings-lifecycle">앱·트레이·종료</h2>
            <p>창 관리와 서버 종료는 다른 동작입니다. MCP 시작·재시작은 연결 화면에서 관리합니다.</p></div>
        </div>
        <div className="settings-exit-grid">
          <div className="settings-exit-action"><strong>트레이로 숨기기</strong>
            <p>앱을 종료하지 않고 창만 숨깁니다.</p>
            <button type="button" className="secondary-btn" disabled={!native || exitBusy}
              onClick={onHide}><Square size={14}/> 트레이로 숨기기</button></div>
          <div className="settings-exit-action"><strong>앱만 종료</strong>
            <p>창은 종료하지만 Tauri 전용 MCP와 터널은 유지합니다.</p>
            <button type="button" className="secondary-btn" disabled={!canExit}
              onClick={onExitApp}><X size={14}/> 앱만 종료</button></div>
          <div className="settings-exit-action"><strong>앱·전용 MCP 완전 종료</strong>
            <p>전용 MCP와 터널을 중지한 후 종료합니다. 확인이 필요합니다.</p>
            <button type="button" className="secondary-btn" disabled={!canExit}
              onClick={onExitAll}><Power size={14}/> 완전 종료</button></div>
        </div>
        <p className="settings-safety"><ShieldCheck size={15}/> 모든 종료 동작은 기존 WinForms 7979 서버를 제어하지 않습니다.</p>
        {trayError && <p className="form-error" role="alert">{trayError}</p>}
        {exitError && <p className="form-error" role="alert">{exitError}</p>}
      </section>
    </div>

    <p className="settings-bottom-note"><LockKeyhole size={14}/> Owner Token과 공개 연결은 연결·보안 화면에서, 실행 환경과 프로젝트는 각 전용 화면에서 관리합니다.</p>
  </div>;
}
