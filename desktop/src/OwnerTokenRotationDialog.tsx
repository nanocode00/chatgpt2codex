import { useState } from "react";
import { AlertTriangle, KeyRound, X } from "lucide-react";
import "./connections.css";

interface OwnerTokenRotationDialogProps {
  busy: boolean;
  ready: boolean;
  running: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/** Typed acknowledgement is required even if the dialog is opened from another screen. */
export function OwnerTokenRotationDialog({
  busy, ready, running, error, onCancel, onConfirm
}: OwnerTokenRotationDialogProps) {
  const [typed, setTyped] = useState("");
  const canConfirm = !busy && ready && !running && typed === "재발급";

  return <div className="connections-dialog-overlay">
    <section className="connections-dialog" role="dialog" aria-modal="true"
      aria-labelledby="connections-rotate-title" aria-describedby="connections-rotate-description"
      onKeyDown={event => {
        if (event.key === "Escape" && !busy) {
          event.preventDefault();
          onCancel();
        }
      }}>
      <header className="connections-dialog-heading">
        <div className="connections-dialog-symbol"><KeyRound size={21}/></div>
        <button type="button" className="connections-dialog-close" aria-label="닫기"
          disabled={busy} onClick={onCancel}><X size={18}/></button>
      </header>
      <h2 id="connections-rotate-title">Owner Token 재발급</h2>
      <p id="connections-rotate-description" className="connections-dialog-intro">
        Tauri 전용 Owner Token을 새로운 값으로 교체합니다. 기존 토큰은 더 이상 사용할 수 없습니다.
      </p>
      <div className="connections-dialog-warning" role="note">
        <AlertTriangle size={18}/>
        <div>
          <strong>기존 OAuth 승인이 모두 무효화됩니다.</strong>
          <p>재발급 후 ChatGPT 연결을 다시 승인해야 합니다. 기존 WinForms/default:7979 인스턴스는 변경하지 않습니다.</p>
        </div>
      </div>
      <form onSubmit={event => {
        event.preventDefault();
        if (canConfirm) onConfirm();
      }}>
        <label htmlFor="connections-rotation-confirm">계속하려면 <strong>재발급</strong>을 입력하세요.</label>
        <input id="connections-rotation-confirm" type="text" autoFocus autoComplete="off"
          spellCheck={false} value={typed} disabled={busy}
          onChange={event => setTyped(event.target.value)} placeholder="재발급"/>
        {running && <p className="connections-dialog-error" role="alert">
          전용 MCP가 실행 중입니다. MCP를 중지한 후 다시 시도하세요.
        </p>}
        {!ready && <p className="connections-dialog-error" role="alert">
          토큰 초기 설정이 완료되지 않았습니다.
        </p>}
        {error && <p className="connections-dialog-error" role="alert">{error}</p>}
        <div className="connections-dialog-actions">
          <button className="connections-button secondary" type="button"
            disabled={busy} onClick={onCancel}>취소</button>
          <button className="connections-button danger" type="submit"
            disabled={!canConfirm}>{busy ? "재발급 중..." : "Owner Token 재발급"}</button>
        </div>
      </form>
    </section>
  </div>;
}
