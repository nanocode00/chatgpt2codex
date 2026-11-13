import type { FormEvent } from "react";
import {
  Activity, HardDrive, Power, RefreshCcw, Square
} from "lucide-react";
import type { PreviewStartupInspection } from "./runtime";
import "./settings-screen.css";

interface SettingsScreenProps {
  native: boolean;
  port: number;
  draftPort: string;
  onDraftPort: (value: string) => void;
  onSavePort: (event: FormEvent<HTMLFormElement>) => void;
  autoRefresh: boolean;
  onAutoRefresh: (enabled: boolean) => void;
  settingError: string;
  previewStartup: PreviewStartupInspection | null;
  startupBusy: boolean;
  startupError: string;
  onRefreshStartup: () => void;
  onToggleStartup: (enabled: boolean) => void;
  portBusy: boolean;
  exitBusy: boolean;
  ownedBusy: boolean;
  exitError: string;
  trayError: string;
  onHide: () => void;
  onExitAll: () => void;
}

export function SettingsScreen({
  native, port, draftPort, onDraftPort, onSavePort, autoRefresh,
  onAutoRefresh, settingError, previewStartup,
  startupBusy, startupError, onRefreshStartup, onToggleStartup,
  portBusy, exitBusy, ownedBusy, exitError, trayError, onHide, onExitAll
}: SettingsScreenProps) {
  const canExit = native && !exitBusy && !ownedBusy;

  return <div className="settings-screen">
    <header className="settings-heading">
      <h1>설정</h1>
    </header>

    <div className="settings-grid">
      <section className="panel settings-card" aria-labelledby="settings-startup">
        <div className="settings-card-heading">
          <span className="icon-tile"><Power size={18}/></span>
          <h2 id="settings-startup">Windows 자동 시작</h2>
        </div>
        <div className="settings-option">
          <div><strong>로그인 시 실행</strong>
            {(!native || (previewStartup && !previewStartup.supported && !previewStartup.conflict)) &&
              <p>휴대용 ZIP에서는 변경할 수 없습니다.</p>}</div>
          <button type="button" className={"switch " + (previewStartup?.enabled ? "enabled" : "")}
            role="switch" aria-label="Tauri 로그인 자동 시작"
            aria-checked={previewStartup?.enabled ?? false}
            disabled={!native || !previewStartup?.supported || !!previewStartup.conflict || startupBusy}
            onClick={() => onToggleStartup(!previewStartup?.enabled)}><span /></button>
        </div>
        <div className="settings-card-footer">
          <button type="button" className="secondary-btn" disabled={!native || startupBusy}
            onClick={onRefreshStartup}><RefreshCcw size={14}/> 상태 확인</button>
        </div>
        {previewStartup?.conflict && <p className="settings-warning" role="alert">자동 시작 등록 충돌로 변경할 수 없습니다.</p>}
        {startupError && <p className="form-error" role="alert">{startupError}</p>}
      </section>

      <section className="panel settings-card" aria-labelledby="settings-monitor">
        <div className="settings-card-heading">
          <span className="icon-tile"><Activity size={18}/></span>
          <h2 id="settings-monitor">서버 포트 설정</h2>
        </div>
        <form className="settings-monitor-form" onSubmit={onSavePort}>
          <label htmlFor="settings-monitor-port">MCP 수신 포트</label>
          <div className="settings-port-row">
            <input id="settings-monitor-port" inputMode="numeric" type="number" min="1" max="65535"
              value={draftPort} onChange={event => onDraftPort(event.target.value)}
              disabled={!native || portBusy || ownedBusy}/>
            <button className="secondary-btn" type="submit" disabled={!native || portBusy || ownedBusy}>
              {portBusy ? "변경 중..." : "포트 적용"}
            </button>
          </div>
          <p className="settings-support">현재: 127.0.0.1:{port}</p>
          {settingError && <p className="form-error" role="alert">{settingError}</p>}
        </form>
        <div className="settings-option">
          <div><strong>자동 상태 확인</strong><p>10초 간격</p></div>
          <button type="button" className={"switch " + (autoRefresh ? "enabled" : "")}
            role="switch" aria-label="자동 상태 확인" aria-checked={autoRefresh}
            onClick={() => onAutoRefresh(!autoRefresh)}><span /></button>
        </div>
      </section>

      <section className="panel settings-card settings-wide" aria-labelledby="settings-lifecycle">
        <div className="settings-card-heading">
          <span className="icon-tile"><HardDrive size={18}/></span>
          <h2 id="settings-lifecycle">창 및 종료</h2>
        </div>
        <div className="settings-exit-grid">
          <div className="settings-exit-action">
            <p>MCP 서버 유지</p>
            <button type="button" className="secondary-btn" disabled={!native || exitBusy}
              onClick={onHide}><Square size={14}/> 트레이로 숨기기</button></div>
          <div className="settings-exit-action">
            <p>MCP 서버·터널 종료</p>
            <button type="button" className="secondary-btn" disabled={!canExit}
              onClick={onExitAll}><Power size={14}/> 종료</button></div>
        </div>
        {trayError && <p className="form-error" role="alert">{trayError}</p>}
        {exitError && <p className="form-error" role="alert">{exitError}</p>}
      </section>
    </div>
  </div>;
}
