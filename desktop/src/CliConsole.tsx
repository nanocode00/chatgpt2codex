import { useEffect, useRef, useState } from "react";
import { CheckCircle2, ClipboardCopy, Clock3, Play, RefreshCcw, TerminalSquare, XCircle } from "lucide-react";
import {
  checkOwnedCliConsole, isNativeApp, runOwnedCliConsole,
  type CliConsoleCheck, type OwnedCliParityResponse
} from "./runtime";
import "./cli-console.css";

const EXAMPLES = [
  { label: "상태 조회", command: "c2c status" },
  { label: "Health", command: "c2c health" },
  { label: "서버 로그", command: "c2c logs --component server" },
  { label: "터널 로그", command: "c2c logs --component tunnel" },
  { label: "프로젝트 목록", command: "c2c repository list" },
  { label: "프로필 목록", command: "c2c profile list" },
  { label: "설정 조회", command: "c2c config show" },
  { label: "사용법", command: "c2c help" }
];

interface HistoryEntry {
  id: number;
  input: string;
  at: string;
  elapsedMs: number;
  result: OwnedCliParityResponse | null;
  error: string | null;
}

interface PendingCommand {
  command: string;
  checked: CliConsoleCheck;
}

// In-memory only: preserve console history when navigating between screens,
// but never write commands or potentially sensitive output to disk.
let sessionHistory: HistoryEntry[] = [];
let sessionSequence = 0;
let sessionDraft = "c2c status";

function errorText(error: unknown) {
  return (typeof error === "string" ? error : error instanceof Error ? error.message : "CLI 실행에 실패했습니다.").slice(0, 500);
}

function outputText(entry: HistoryEntry): string {
  if (entry.error) return entry.error;
  if (!entry.result) return "출력이 없습니다.";
  return entry.result.text ?? JSON.stringify(entry.result.json, null, 2) ?? "출력이 없습니다.";
}

export function CliConsole({ onNotify, onRuntimeChanged }: {
  onNotify?: (message: string, tone?: "info" | "error") => void;
  onRuntimeChanged?: () => void;
}) {
  const native = isNativeApp();
  const [input, setInput] = useState(sessionDraft);
  const [validation, setValidation] = useState<CliConsoleCheck | null>(null);
  const [validationError, setValidationError] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>(() => sessionHistory);
  const [selectedId, setSelectedId] = useState<number | null>(() => sessionHistory[0]?.id ?? null);
  const inputRef = useRef<HTMLInputElement>(null);
  const historyCursor = useRef(-1);
  const historyDraft = useRef(sessionDraft);
  const runningSince = useRef(0);
  const selected = history.find(item => item.id === selectedId) ?? history[0] ?? null;
  const updateInput = (command: string, browsingHistory = false) => {
    if (!browsingHistory) {
      historyCursor.current = -1;
      historyDraft.current = command;
    }
    sessionDraft = command;
    setInput(command);
  };

  useEffect(() => {
    if (!busy) return;
    const ticker = window.setInterval(() => {
      setElapsedMs(Math.round(performance.now() - runningSince.current));
    }, 100);
    return () => window.clearInterval(ticker);
  }, [busy]);

  useEffect(() => {
    if (!pending) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setPending(null);
      }
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [pending]);

  useEffect(() => {
    const current = input.trim();
    setValidation(null);
    setValidationError("");
    if (!current || !native) {
      setChecking(false);
      return;
    }
    let active = true;
    setChecking(true);
    const timer = window.setTimeout(() => {
      void checkOwnedCliConsole(current).then(next => {
        if (!active) return;
        setValidation(next);
        setValidationError("");
      }).catch(error => {
        if (!active) return;
        setValidation(null);
        setValidationError(errorText(error));
      }).finally(() => { if (active) setChecking(false); });
    }, 240);
    return () => { active = false; window.clearTimeout(timer); };
  }, [input, native]);

  async function checkNow() {
    if (!native || busy || !input.trim()) return;
    setChecking(true);
    try {
      const next = await checkOwnedCliConsole(input.trim());
      setValidation(next);
      setValidationError("");
    } catch (error) {
      setValidation(null);
      setValidationError(errorText(error));
    } finally {
      setChecking(false);
    }
  }

  async function execute() {
    if (!native || busy || pending || !input.trim()) return;
    const command = input.trim();
    let checked: CliConsoleCheck;
    try {
      checked = await checkOwnedCliConsole(command);
      setValidation(checked);
      setValidationError("");
    } catch (error) {
      setValidation(null);
      setValidationError(errorText(error));
      return;
    }
    if (checked.mutating) {
      setPending({ command, checked });
      return;
    }
    await runChecked(command, checked);
  }

  async function runChecked(command: string, checked: CliConsoleCheck) {
    setBusy(true);
    setElapsedMs(0);
    const started = performance.now();
    runningSince.current = started;
    let result: OwnedCliParityResponse | null = null;
    let error: string | null = null;
    try {
      result = await runOwnedCliConsole(command, checked.mutating);
      if (checked.mutating) onRuntimeChanged?.();
    } catch (reason) {
      error = errorText(reason);
      onNotify?.(error, "error");
    } finally {
      const id = ++sessionSequence;
      const entry: HistoryEntry = {
        id, input: command, at: new Date().toLocaleTimeString("ko-KR", { hour12: false }),
        elapsedMs: Math.round(performance.now() - started), result, error
      };
      setHistory(previous => {
        const next = [entry, ...previous].slice(0, 25);
        sessionHistory = next;
        return next;
      });
      setSelectedId(id);
      setBusy(false);
    }
  }

  function navigateHistory(direction: "up" | "down") {
    if (history.length === 0 || busy || pending) return;
    if (direction === "up") {
      if (historyCursor.current === -1) historyDraft.current = input;
      historyCursor.current = Math.min(historyCursor.current + 1, history.length - 1);
    } else {
      if (historyCursor.current === -1) return;
      historyCursor.current -= 1;
    }
    const command = historyCursor.current === -1
      ? historyDraft.current
      : history[historyCursor.current].input;
    updateInput(command, true);
  }

  function pickCommand(command: string) {
    updateInput(command);
    inputRef.current?.focus();
  }

  async function copyOutput() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(outputText(selected));
      onNotify?.("실행 결과를 복사했습니다.");
    } catch {
      onNotify?.("결과 복사에 실패했습니다.", "error");
    }
  }

  return <div className="cli-console">
    <section className="panel cli-console-editor">
      <div className="cli-console-title"><TerminalSquare size={18}/><h2>명령 실행</h2><span>C2C CLI</span></div>
      <label htmlFor="cli-command-input">CLI 명령</label>
      <div className="cli-console-input-row">
        <span aria-hidden="true">$</span>
        <input id="cli-command-input" ref={inputRef} value={input} maxLength={512}
          autoComplete="off" spellCheck={false} placeholder="c2c status"
          disabled={busy || pending !== null}
          onChange={event => updateInput(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault(); void execute();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault(); navigateHistory(event.key === "ArrowUp" ? "up" : "down");
            }
          }}/>
      </div>
      <div className="cli-console-status" aria-live="polite">
        {!native ? <span className="cli-console-invalid"><XCircle size={14}/> Windows 앱에서만 실행할 수 있습니다.</span> :
        busy ? <span className="cli-console-running"><RefreshCcw size={14}/> CLI 실행 중 · {(elapsedMs / 1000).toFixed(1)}초</span> :
        !input.trim() ? <span>명령을 입력하세요.</span> :
        checking && !validation && !validationError ? <span><RefreshCcw size={14}/> 문법 검사 중…</span> :
        validation ? <span className="cli-console-valid"><CheckCircle2 size={14}/> 문법 확인 · {validation.note}</span> :
        validationError ? <span className="cli-console-invalid"><XCircle size={14}/> {validationError}</span> : <span>명령을 검사하고 있습니다.</span>}
      </div>
      {validation && validation.command !== input.trim() && <p className="cli-console-normalized">
        실제 실행: <code>{validation.command}</code>
      </p>}
      <div className="cli-console-buttons">
        <button type="button" className="secondary-btn" disabled={!native || busy || pending !== null || checking || !input.trim()} onClick={() => { void checkNow(); }}>
          문법 검사
        </button>
        <button type="button" className="secondary-btn cli-console-run" disabled={!native || busy || pending !== null || !input.trim()} onClick={() => { void execute(); }}>
          <Play size={14}/> {busy ? "실행 중…" : "실행"}
        </button>
        <span>Enter 실행 · ↑/↓ 기록 탐색</span>
      </div>
      <div className="cli-console-examples">
        <strong>빠른 입력</strong>
        <div>{EXAMPLES.map(example => <button key={example.command} className="cli-console-example"
          type="button" disabled={busy || pending !== null} title={example.command}
          onClick={() => pickCommand(example.command)}>{example.label}</button>)}</div>
      </div>
    </section>

    <div className="cli-console-workspace">
      <section className="panel cli-console-result">
        <div className="cli-console-section-head"><h2>실행 결과</h2>
          <button type="button" className="secondary-btn" disabled={!selected} onClick={() => { void copyOutput(); }}>
            <ClipboardCopy size={13}/> 복사
          </button>
        </div>
        {!selected ? <div className="cli-console-empty">명령을 실행하면 결과가 여기에 표시됩니다.</div> :
          <>
            <div className="cli-console-result-meta">
              <code>{selected.input}</code>
              <span className={selected.error ? "cli-console-failed" : "cli-console-succeeded"}>
                {selected.error ? "실패" : "완료"}
              </span>
              <span>{selected.elapsedMs.toLocaleString()}ms</span>
            </div>
            <pre className="cli-console-output" aria-label="CLI 출력">{outputText(selected)}</pre>
            {selected.result?.note && <p className="cli-console-note">{selected.result.note}</p>}
          </>}
      </section>

      <section className="panel cli-console-history">
        <div className="cli-console-section-head"><h2>실행 기록</h2>
          <span>현재 세션 · 최대 25건</span>
        </div>
        {history.length === 0 ? <div className="cli-console-empty">아직 실행 기록이 없습니다.</div> :
          <div className="cli-console-history-items">
            {history.map(entry => <button type="button" key={entry.id}
              className={"cli-console-history-item" + (selected?.id === entry.id ? " selected" : "")}
              aria-current={selected?.id === entry.id ? "true" : undefined}
              onClick={() => setSelectedId(entry.id)}>
              {entry.error ? <XCircle size={14}/> : <CheckCircle2 size={14}/>}
              <span title={entry.input}>{entry.input}</span>
              <small><Clock3 size={12}/>{entry.at}</small>
            </button>)}
          </div>}
      </section>
    </div>
    <p className="cli-console-footnote">
      검증된 C2C 명령만 실행합니다. 셸 연결·파일 리다이렉션 및 고위험 명령은 지원하지 않습니다.
      전체 지원 문법은 <code>c2c help</code>로 확인하세요.
    </p>
    {pending && <div className="cli-console-confirm-backdrop">
      <div className="cli-console-confirm" role="dialog" aria-modal="true"
        aria-labelledby="cli-console-confirm-title" aria-describedby="cli-console-confirm-description">
        <h2 id="cli-console-confirm-title">CLI 명령 실행 확인</h2>
        <p id="cli-console-confirm-description">이 명령은 서버 또는 저장된 상태를 변경할 수 있습니다.</p>
        <code>{pending.checked.command}</code>
        <div className="cli-console-confirm-actions">
          <button type="button" className="secondary-btn" autoFocus
            onClick={() => setPending(null)}>취소</button>
          <button type="button" className="secondary-btn cli-console-run"
            onClick={() => {
              const action = pending;
              setPending(null);
              void runChecked(action.command, action.checked);
            }}>실행 확인</button>
        </div>
      </div>
    </div>}
  </div>;
}
