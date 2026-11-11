import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity, AlertCircle, ArrowRight, Ban, CheckCircle2, ChevronRight, CirclePause,
  ClipboardCopy, Clock3, FileText, History, Layers, LoaderCircle,
  Play, RefreshCcw, Search, ShieldCheck, X
} from "lucide-react";
import { isNativeApp, runOwnedCliParity } from "./runtime";
import {
  filterJobs, jobStatusText, parseJobDetail, parseJobList, parseJobLogs,
  permittedJobAction, safeTurnPreview, type JobDetail, type JobFilter, type JobLogs
} from "./job-model";
import type { JobListItem } from "./job-list";
import "./jobs.css";

interface JobsScreenProps {
  onNotify: (message: string, tone?: "info" | "error") => void;
  onProjects: () => void;
  refreshKey: number;
}
function errorText(error: unknown): string {
  return (typeof error === "string" ? error : error instanceof Error ? error.message : "작업 조회에 실패했습니다.").slice(0, 460);
}
function timeText(value: string | null): string {
  if (!value) return "정보 없음";
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? "정보 없음" : instant.toLocaleString("ko-KR");
}
const filterItems: { id: JobFilter; label: string; symbol: "layers" | "active" | "attention" | "history" }[] = [
  { id: "all", label: "전체 작업", symbol: "layers" },
  { id: "active", label: "활성", symbol: "active" },
  { id: "attention", label: "대기·차단", symbol: "attention" },
  { id: "history", label: "완료·취소", symbol: "history" }
];
export function JobsScreen({ onNotify, onProjects, refreshKey }: JobsScreenProps) {
  const native = isNativeApp();
  const [items, setItems] = useState<JobListItem[] | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const listLock = useRef(false);
  const [listError, setListError] = useState("");
  const [filter, setFilter] = useState<JobFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<JobDetail | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [logs, setLogs] = useState<JobLogs | null>(null);
  const [logsBusy, setLogsBusy] = useState(false);
  const [logsError, setLogsError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [revision, setRevision] = useState(0);

  const filtered = useMemo(() => filterJobs(items ?? [], filter, query), [items, filter, query]);
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0] ?? null;
  const count = items?.length ?? 0;
  const activeCount = items?.filter(item => item.status === "active").length ?? 0;
  const attentionCount = items?.filter(item => item.status === "paused" || item.status === "blocked").length ?? 0;
  const historyCount = items?.filter(item => item.status === "completed" || item.status === "canceled").length ?? 0;
  const counts: Record<string, number> = { all: count, active: activeCount, attention: attentionCount, history: historyCount };
  const busy = listBusy || detailsBusy || logsBusy || actionBusy;

  const reloadList = useCallback(async (quiet = false) => {
    if (!native || listLock.current) return;
    listLock.current = true;
    setListBusy(true);
    try {
      const response = await runOwnedCliParity({ operation: "job-list" });
      const parsed = parseJobList(response.json);
      if (!parsed) throw new Error("작업 목록의 응답 형식이 올바르지 않습니다.");
      setItems(parsed);
      setListError("");
    } catch (err) {
      const message = errorText(err);
      setListError(message);
      if (!quiet) onNotify(message, "error");
    } finally {
      listLock.current = false;
      setListBusy(false);
    }
  }, [native, onNotify]);

  useEffect(() => {
    void reloadList(true);
    if (!native) return;
    const interval = window.setInterval(() => { void reloadList(true); }, 45_000);
    const onFocus = () => { void reloadList(true); };
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [native, reloadList, refreshKey]);

  useEffect(() => {
    if (!native || !selected) {
      setDetails(null);
      setDetailsError("");
      setLogs(null);
      setLogsError("");
      setDetailsBusy(false);
      return;
    }
    let active = true;
    setDetails(null);
    setLogs(null);
    setLogsError("");
    setDetailsError("");
    setDetailsBusy(true);
    void runOwnedCliParity({ operation: "job-status", target: selected.id })
      .then(response => {
        if (!active) return;
        const parsed = parseJobDetail(response.json, selected.id);
        if (!parsed) throw new Error("작업 상세 정보가 유효하지 않습니다.");
        setDetails(parsed);
      })
      .catch(err => { if (active) setDetailsError(errorText(err)); })
      .finally(() => { if (active) setDetailsBusy(false); });
    return () => { active = false; };
  }, [native, selected?.id, selected?.status, revision]);

  async function showLogs() {
    if (!native || busy || !selected || !details) return;
    setLogsBusy(true);
    setLogsError("");
    try {
      const response = await runOwnedCliParity({ operation: "job-logs", target: selected.id });
      const parsed = parseJobLogs(response.json, selected.id);
      if (!parsed) throw new Error("작업 로그 응답이 올바르지 않습니다.");
      setLogs(parsed);
      onNotify("작업 기록을 최근 10개까지 조회했습니다.");
    } catch (err) {
      setLogsError(errorText(err));
    } finally { setLogsBusy(false); }
  }

  async function transition(action: "resume" | "cancel") {
    if (!native || busy || !selected || !details || details.id !== selected.id ||
        !permittedJobAction(details.status, action)) return;
    const title = action === "resume" ? "상태 활성화" : "상태 취소 기록";
    const explanation = action === "resume"
      ? "저장된 작업을 '활성' 상태로 바꿉니다. 실제 에이전트를 실행하지 않으며, ChatGPT에서 해당 loop ID로 이어서 진행해야 합니다."
      : "저장된 작업을 '취소됨'으로 기록합니다. 이미 실행 중인 에이전트 프로세스를 종료하거나 작업 내용을 삭제하는 기능은 아닙니다.";
    if (!window.confirm(selected.id + "\n\n" + explanation + "\n\n" + title + "을(를) 진행할까요?")) return;
    setActionBusy(true);
    setLogs(null);
    setLogsError("");
    try {
      const response = await runOwnedCliParity({
        operation: action === "resume" ? "job-resume" : "job-cancel",
        target: selected.id
      });
      const result = response.json as Record<string, unknown> | null;
      const expected = action === "resume" ? "active" : "canceled";
      if (!result || result.id !== selected.id || result.status !== expected) {
        throw new Error("CLI의 작업 상태 변경 결과가 예상과 다릅니다. 상태를 다시 조회하세요.");
      }
      setRevision(value => value + 1);
      await reloadList(true);
      onNotify(action === "resume" ? "작업 상태를 활성으로 변경했습니다. 에이전트는 자동 실행되지 않습니다." :
        "작업을 취소 상태로 기록했습니다. 실행 중인 프로세스를 종료한 것은 아닙니다.");
    } catch (err) {
      const message = errorText(err);
      setDetailsError(message);
      onNotify(message, "error");
      await reloadList(true);
      setRevision(value => value + 1);
    } finally { setActionBusy(false); }
  }

  async function copyId() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.id);
      onNotify("작업 ID를 복사했습니다.");
    } catch { onNotify("작업 ID 복사에 실패했습니다.", "error"); }
  }

  return <div className="jobs-root">
    <header className="jobs-heading">
      <div>
        <p className="jobs-eyebrow">WORKSPACE / DURABLE JOBS</p>
        <h1>작업 관리</h1>
        <p>저장된 작업의 진행 상태와 기록을 살펴보고, 다음 진행에 필요한 ID를 확인합니다.</p>
      </div>
      <button type="button" className="jobs-button secondary" disabled={!native || listBusy || actionBusy}
        onClick={() => { void reloadList(); }}>
        <RefreshCcw size={16} className={listBusy ? "jobs-spin" : ""}/>
        {listBusy ? "확인 중" : "목록 새로고침"}
      </button>
    </header>

    <section className="jobs-stats" aria-label="작업 상태 필터">
      {filterItems.map(item => <button type="button" key={item.id}
        aria-pressed={filter === item.id} className={filter === item.id ? "active" : ""}
        onClick={() => { setFilter(item.id); setQuery(""); }}
        disabled={actionBusy || logsBusy}>
        {item.symbol === "layers" ? <Layers size={17}/> : item.symbol === "active" ?
          <Activity size={17}/> : item.symbol === "attention" ? <CirclePause size={17}/> : <History size={17}/>}
        <strong>{items ? counts[item.id] : "—"}</strong><span>{item.label}</span>
      </button>)}
    </section>

    {!native && <div className="jobs-notice"><AlertCircle size={16}/> 작업 조회는 Windows Tauri 앱에서 지원합니다.</div>}
    {listError && <div className="jobs-error" role="alert"><AlertCircle size={16}/>
      <span>목록 확인 실패: {listError}{items && " · 이전 목록이 표시될 수 있습니다."}</span>
    </div>}
    <div className="jobs-layout">
      <section className="jobs-list-panel" aria-labelledby="jobs-list-heading">
        <div className="jobs-panel-heading">
          <div><p>DURABLE JOBS</p><h2 id="jobs-list-heading">저장된 작업</h2></div>
          <span className="jobs-count">{filtered.length} / {filter === "all" ? count : counts[filter]}</span>
        </div>
        <div className="jobs-search">
          <Search size={16}/>
          <input aria-label="작업 ID 또는 프로젝트 ID 검색" placeholder="작업 ID · 프로젝트 ID 검색"
            value={query} onChange={event => setQuery(event.target.value)}/>
          {query && <button type="button" onClick={() => setQuery("")} aria-label="검색 지우기"><X size={15}/></button>}
        </div>
        <div className="jobs-items" role="region" aria-label="작업 목록 스크롤 영역" tabIndex={0}>
          {items === null ? <div className="jobs-empty">
            {listBusy ? <LoaderCircle size={25} className="jobs-spin"/> : <AlertCircle size={25}/>}
            <strong>{listBusy ? "작업을 찾는 중..." : "작업 목록을 읽지 못했습니다."}</strong>
          </div> : filtered.length === 0 ? <div className="jobs-empty">
            <Layers size={28}/>
            <strong>{count === 0 ? "저장된 작업이 없습니다." : "일치하는 작업이 없습니다."}</strong>
            <span>{count === 0 ? "작업이 생성되면 이 화면에 나타납니다." : "다른 검색어 또는 필터를 선택하세요."}</span>
          </div> : filtered.map(job => <button type="button" key={job.id}
            className={"jobs-entry " + (selected?.id === job.id ? "selected" : "")}
            aria-pressed={selected?.id === job.id} disabled={actionBusy || logsBusy}
            onClick={() => { setSelectedId(job.id); setLogs(null); }}>
            <span className="jobs-entry-icon"><FileText size={18}/></span>
            <span className="jobs-entry-text">
              <strong>{job.goalPreview || job.id}</strong>
              <small>{job.projectId ? job.projectId + " · " : ""}{job.id}</small>
            </span>
            <span className={"jobs-state jobs-state-" + job.status}>{jobStatusText(job.status)}</span>
            <ChevronRight size={15}/>
          </button>)}
        </div>
        <div className="jobs-list-hint">작업 ID는 <code>loop-...</code> 형식입니다. 프로젝트 ID와 구별해 주세요.</div>
      </section>

      <section className="jobs-detail-panel" aria-labelledby="jobs-detail-heading">
        <div className="jobs-panel-heading">
          <div><p>JOB INSPECTOR</p><h2 id="jobs-detail-heading">작업 상세</h2></div>
          {selected && <button type="button" className="jobs-button secondary"
            disabled={busy || !native || !details} onClick={() => { void showLogs(); }}>
            <FileText size={15}/>{logsBusy ? "조회 중" : "기록 조회"}
          </button>}
        </div>
        {!selected ? <div className="jobs-empty jobs-inspector-empty">
          <FileText size={28}/>
          <strong>확인할 작업을 선택하세요.</strong>
          <span>저장된 작업이 있는 경우 왼쪽 목록에서 선택할 수 있습니다.</span>
        </div> : <>
          <div className="jobs-detail-title">
            <span className="jobs-detail-icon"><FileText size={20}/></span>
            <div><h3>{selected.id}</h3>
              <span className={"jobs-state jobs-state-" + (details?.status ?? selected.status)}>
                {jobStatusText(details?.status ?? selected.status)}
              </span></div>
          </div>
          {detailsBusy && <p className="jobs-muted"><LoaderCircle size={14} className="jobs-spin"/> 상세 조회 중...</p>}
          {detailsError && <div className="jobs-error" role="alert"><AlertCircle size={15}/>{detailsError}</div>}
          <div className="jobs-info">
            <div className="jobs-field">
              <span>작업 ID</span><div className="jobs-copy-field">
                <code>{selected.id}</code><button type="button" title="작업 ID 복사" aria-label="작업 ID 복사"
                  onClick={() => { void copyId(); }}><ClipboardCopy size={15}/></button>
              </div>
            </div>
            <div className="jobs-field"><span>프로젝트</span><strong>{details?.projectId ?? selected.projectId ?? "정보 없음"}</strong></div>
            <div className="jobs-info-grid">
              <div><Clock3 size={15}/><span>갱신</span><strong>{timeText(details?.updatedAt ?? null)}</strong></div>
              <div><Activity size={15}/><span>진행 횟수</span>
                <strong>{details ? details.turnCount + (details.maxTurns !== null ? " / " + details.maxTurns : "") : "—"}</strong>
              </div>
            </div>
            {details?.goalPreview && <div className="jobs-field"><span>작업 목표</span><p>{details.goalPreview}</p></div>}
            {details?.nextActions.length ? <div className="jobs-field">
              <span>후속 단계</span>
              <ul className="jobs-actions-list">{details.nextActions.map((item,i)=><li key={i}>{item}</li>)}</ul>
            </div> : null}
          </div>
          <div className="jobs-transitions">
            <p>상태 변경은 저장된 Job 기록에만 적용됩니다. <strong>에이전트를 실행하거나 중지하지 않습니다.</strong></p>
            <div>
              <button type="button" className="jobs-button secondary"
                disabled={busy || !details || !permittedJobAction(details.status, "resume")}
                onClick={() => { void transition("resume"); }}><Play size={15}/> 활성으로 변경</button>
              <button type="button" className="jobs-button danger"
                disabled={busy || !details || !permittedJobAction(details.status, "cancel")}
                onClick={() => { void transition("cancel"); }}><Ban size={15}/> 취소 상태로 기록</button>
            </div>
          </div>
          {logsError && <div className="jobs-error" role="alert"><AlertCircle size={15}/>{logsError}</div>}
          {logs && <section className="jobs-logs" aria-label="최근 작업 기록">
            <div className="jobs-logs-title"><FileText size={16}/><strong>최근 작업 기록</strong>
              <span>{logs.turns.length}개 · 최대 10개</span></div>
            {logs.turns.length === 0 && <p>저장된 진행 기록이 없습니다.</p>}
            {logs.turns.map((turn,i)=><details key={i}>
              <summary>진행 기록 {i + 1}</summary>
              <pre>{safeTurnPreview(turn)}</pre>
            </details>)}
            {logs.lastResult && <details><summary>마지막 결과 미리보기</summary>
              <pre>{safeTurnPreview(logs.lastResult)}</pre>
            </details>}
            <p>표시 내용은 로컬 작업 기록입니다. 내보내기 전 민감 정보를 확인하세요.</p>
          </section>}
        </>}
      </section>
    </div>
    <div className="jobs-bottom">
      <div className="jobs-guide">
        <CheckCircle2 size={18}/>
        <div><strong>작업 상태와 실제 실행은 구분됩니다.</strong>
          <p>‘활성으로 변경’ 후에는 ChatGPT에서 해당 loop ID로 직접 작업을 이어야 합니다.
            ‘취소 상태로 기록’은 에이전트 프로세스를 강제 종료하지 않습니다.</p>
          <button type="button" onClick={onProjects}>프로젝트 목록 보기 <ArrowRight size={14}/></button>
        </div>
      </div>
      <div className="jobs-boundary"><ShieldCheck size={15}/>
        격리된 Tauri 전용 작업 기록만 조회·수정합니다. 기존 WinForms/7979와 로컬 프로젝트 파일은 변경하지 않습니다.
      </div>
    </div>
  </div>;
}
