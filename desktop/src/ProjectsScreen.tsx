import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ArrowRight, CheckCircle2, ChevronRight, ClipboardCopy, FolderOpen,
  FolderPlus, FolderSearch2, GitBranch, Info, LoaderCircle, RefreshCcw,
  Search, ShieldCheck, Trash2, X
} from "lucide-react";
import {
  isNativeApp, runOwnedCliParity,
  type CatalogInspection, type PickedRepositoryFolder
} from "./runtime";
import { displayProjectPath, filterProjects, parseProjectDetails, type ProjectDetails } from "./project-details";
import "./projects.css";

interface ProjectsScreenProps {
  catalog: CatalogInspection | null;
  catalogBusy: boolean;
  catalogError: string;
  ownedRunning: boolean;
  ownedBusy: boolean;
  pickedFolder: PickedRepositoryFolder | null;
  folderBusy: boolean;
  folderName: string;
  folderId: string;
  folderError: string;
  unregisterTarget: string | null;
  unregisterTyped: string;
  unregisterBusy: boolean;
  unregisterError: string;
  onRefresh: () => void;
  onBrowse: () => void;
  onCancelBrowse: () => void;
  onFolderName: (value: string) => void;
  onFolderId: (value: string) => void;
  onRegister: () => void;
  onRequestUnregister: (id: string) => void;
  onCancelUnregister: () => void;
  onUnregisterTyped: (value: string) => void;
  onConfirmUnregister: () => void;
  onNotify: (message: string, tone?: "info" | "error") => void;
  onManageRuntime: () => void;
}

export function ProjectsScreen({
  catalog, catalogBusy, catalogError, ownedRunning, ownedBusy,
  pickedFolder, folderBusy, folderName, folderId, folderError,
  unregisterTarget, unregisterTyped, unregisterBusy, unregisterError,
  onRefresh, onBrowse, onCancelBrowse, onFolderName, onFolderId, onRegister,
  onRequestUnregister, onCancelUnregister, onUnregisterTyped, onConfirmUnregister,
  onNotify, onManageRuntime
}: ProjectsScreenProps) {
  const native = isNativeApp();
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [details, setDetails] = useState<ProjectDetails | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const entries = catalog?.available ? catalog.projects : [];
  const filtered = useMemo(() => filterProjects(entries, search), [entries, search]);
  const selected = filtered.find(project => project.id === selectedId) ?? filtered[0] ?? null;
  const ready = native && catalog?.available === true;
  const busy = ownedBusy || catalogBusy || folderBusy || unregisterBusy;
  const canEdit = ready && !ownedRunning && !busy && unregisterTarget === null && !pickedFolder;
  const healthy = entries.filter(project => project.available).length;

  useEffect(() => {
    if (!selected || !native || !catalog?.available || !selected.available) {
      setDetails(null);
      setDetailsBusy(false);
      setDetailsError("");
      return;
    }
    let active = true;
    setDetails(null);
    setDetailsError("");
    setDetailsBusy(true);
    void runOwnedCliParity({ operation: "repository-show", target: selected.id })
      .then(result => {
        if (!active) return;
        const parsed = parseProjectDetails(result.json, selected.id);
        if (!parsed) throw new Error("프로젝트 상세 응답이 유효하지 않습니다.");
        setDetails(parsed);
      })
      .catch(err => {
        if (!active) return;
        const message = typeof err === "string" ? err : err instanceof Error ? err.message : "프로젝트 상세 조회에 실패했습니다.";
        setDetailsError(message.slice(0, 350));
      })
      .finally(() => {
        if (active) setDetailsBusy(false);
      });
    return () => { active = false; };
  }, [native, selected?.id, selected?.available, catalog]);

  async function copy(text: string, kind: string) {
    try {
      await navigator.clipboard.writeText(text);
      onNotify(kind + " 복사 완료");
    } catch {
      onNotify(kind + " 복사에 실패했습니다.", "error");
    }
  }

  return <div className="projects-root">
    <header className="projects-heading">
      <div>
        <p className="projects-eyebrow">WORKSPACE / PROJECTS</p>
        <h1>프로젝트 관리</h1>
        <p>ChatGPT가 작업할 프로젝트를 등록하고, 경로와 실행 준비 상태를 확인합니다.</p>
      </div>
      <div className="projects-header-actions">
        <button type="button" className="projects-button secondary" onClick={onRefresh}
          disabled={!native || catalogBusy || folderBusy || unregisterBusy}>
          <RefreshCcw size={16} className={catalogBusy ? "projects-spinning" : ""}/>
          목록 새로고침
        </button>
        <button type="button" className="projects-button primary" onClick={onBrowse} disabled={!canEdit}>
          <FolderPlus size={16}/> 프로젝트 추가
        </button>
      </div>
    </header>

    <section className="projects-stats" aria-label="프로젝트 요약">
      <div><strong>{ready ? entries.length : "—"}</strong><span>등록된 프로젝트</span></div>
      <div><strong>{ready ? healthy : "—"}</strong><span>사용 가능한 폴더</span></div>
      <div><strong>{ready ? entries.length - healthy : "—"}</strong><span>경로 확인 필요</span></div>
    </section>

    {ownedRunning && <div className="projects-notice" role="status">
      <Info size={17}/>
      <span>현재 Tauri MCP가 실행 중이어서 프로젝트 등록·해제가 잠겨 있습니다. 기존 안전 정책에 따라 MCP를 중지하면 변경할 수 있습니다. 실제 폴더는 삭제되지 않습니다.</span>
      <button type="button" onClick={onManageRuntime}>서버 관리 <ArrowRight size={14}/></button>
    </div>}
    {catalogError && <div className="projects-error" role="alert"><AlertCircle size={16}/>{catalogError}</div>}
    {catalog && !catalog.available && <div className="projects-notice"><Info size={16}/> Tauri 전용 CLI 프로젝트 목록을 조회할 수 없습니다. 번들 런타임을 확인하세요.</div>}

    {pickedFolder && <section className="projects-register" aria-label="새 프로젝트 등록">
      <header className="projects-panel-head">
        <div><p>NEW PROJECT</p><h2>프로젝트 등록</h2></div>
        <button type="button" className="projects-icon-button" onClick={onCancelBrowse}
          disabled={folderBusy} aria-label="등록 취소"><X size={17}/></button>
      </header>
      <p className="projects-help">선택된 폴더는 등록할 때까지 변경하지 않습니다. 실제 파일 이동이나 복사도 수행하지 않습니다.</p>
      <form className="projects-register-grid" onSubmit={event => { event.preventDefault(); onRegister(); }}>
        <label className="wide">선택한 폴더
          <input readOnly value={displayProjectPath(pickedFolder.path)} aria-label="선택된 프로젝트 폴더"/>
        </label>
        <label>표시 이름
          <input value={folderName} maxLength={160} onChange={e => onFolderName(e.target.value)}
            autoComplete="off" disabled={folderBusy} aria-label="프로젝트 표시 이름"/>
        </label>
        <label>프로젝트 ID
          <input value={folderId} maxLength={64} onChange={e => onFolderId(e.target.value)}
            autoComplete="off" spellCheck={false} disabled={folderBusy} aria-label="프로젝트 ID"/>
        </label>
        <p className="projects-help wide">ID는 영문 소문자·숫자로 시작하고 점(.)·밑줄(_)·하이픈(-)을 사용할 수 있습니다. ChatGPT 도구 호출의 projectId로 사용됩니다.</p>
        {folderError && <div className="projects-error wide" role="alert"><AlertCircle size={15}/>{folderError}</div>}
        <div className="projects-form-actions wide">
          <button type="button" className="projects-button secondary" onClick={onCancelBrowse} disabled={folderBusy}>취소</button>
          <button type="submit" className="projects-button primary" disabled={folderBusy || ownedRunning || !ready}>
            {folderBusy && <LoaderCircle size={15} className="projects-spinning"/>} 등록 확인
          </button>
        </div>
      </form>
    </section>}

    <div className="projects-layout">
      <section className="projects-list-panel" aria-labelledby="projects-list-heading">
        <div className="projects-panel-head">
          <div><p>WORKSPACE CATALOG</p><h2 id="projects-list-heading">프로젝트 목록</h2></div>
          <span className="projects-count">{filtered.length} / {entries.length}</span>
        </div>
        <div className="projects-search">
          <Search size={16}/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="이름 또는 ID 검색" aria-label="프로젝트 이름 또는 ID 검색"/>
          {search && <button type="button" onClick={() => setSearch("")} aria-label="검색 지우기"><X size={14}/></button>}
        </div>
        <div className="projects-entries" role="region" aria-label="프로젝트 목록 스크롤 영역" tabIndex={0}>
          {catalogBusy && !catalog && <div className="projects-empty">목록을 확인하고 있습니다.</div>}
          {!catalogBusy && catalog?.available && entries.length === 0 && <div className="projects-empty">
            <FolderSearch2 size={28}/>
            <strong>등록된 프로젝트가 없습니다.</strong>
            <span>프로젝트 추가를 눌러 개발 폴더를 등록하세요.</span>
          </div>}
          {catalog?.available && entries.length > 0 && filtered.length === 0 && <div className="projects-empty">
            <Search size={25}/><strong>검색 결과가 없습니다.</strong><span>다른 이름이나 ID로 검색해 보세요.</span>
          </div>}
          {filtered.map(project => <button type="button" key={project.id}
            className={"projects-entry " + (selected?.id === project.id ? "selected" : "")}
            aria-pressed={selected?.id === project.id}
            onClick={() => setSelectedId(project.id)}>
            <span className="projects-entry-icon"><FolderOpen size={18}/></span>
            <span className="projects-entry-text"><strong>{project.name}</strong>
              <small>{project.id}</small></span>
            <span className={"projects-status " + (project.available ? "ok" : "missing")}>
              {project.available ? "경로 확인됨" : "폴더 없음"}
            </span>
            <ChevronRight size={15} className="projects-entry-arrow"/>
          </button>)}
        </div>
      </section>

      <section className="projects-detail-panel" aria-labelledby="projects-detail-heading">
        <div className="projects-panel-head">
          <div><p>PROJECT INSPECTOR</p><h2 id="projects-detail-heading">프로젝트 상세</h2></div>
        </div>
        {!selected ? <div className="projects-empty detail-empty">
          <FolderSearch2 size={27}/>
          <strong>확인할 프로젝트를 선택하세요.</strong>
          <span>프로젝트를 등록하거나 왼쪽 목록에서 선택할 수 있습니다.</span>
        </div> : <>
          <div className="projects-detail-title">
            <div className="projects-detail-icon"><FolderOpen size={21}/></div>
            <div><h3>{selected.name}</h3>
              <span className={"projects-status " + (selected.available ? "ok" : "missing")}>
                {selected.available ? "폴더 접근 가능" : "폴더를 찾을 수 없음"}
              </span>
            </div>
          </div>
          <div className="projects-property">
            <span>프로젝트 ID</span>
            <div className="projects-property-value"><code>{selected.id}</code>
              <button type="button" aria-label="프로젝트 ID 복사" title="ID 복사" onClick={() => { void copy(selected.id, "프로젝트 ID"); }}><ClipboardCopy size={15}/></button>
            </div>
          </div>
          <div className="projects-property">
            <span>등록 경로</span>
            {details ? <div className="projects-property-value">
                <code className="projects-path">{displayProjectPath(details.root)}</code>
                <button type="button" aria-label="프로젝트 경로 복사" title="경로 복사"
                  onClick={() => { void copy(displayProjectPath(details.root), "프로젝트 경로"); }}><ClipboardCopy size={15}/></button>
              </div> :
              <p>{selected.available ? detailsBusy ? "경로 확인 중..." : "상세 정보를 확인하지 못했습니다." : "디렉터리를 찾을 수 없어 조회하지 않았습니다."}</p>}
          </div>
          {detailsBusy && <p className="projects-help"><LoaderCircle size={14} className="projects-spinning"/> 현재 폴더 정보를 확인하는 중입니다.</p>}
          {detailsError && <div className="projects-error" role="alert"><AlertCircle size={15}/>{detailsError}</div>}
          {details && <div className="projects-detail-metadata">
            <div><GitBranch size={16}/><span>Git 브랜치</span><strong>{details.branch ?? "정보 없음"}</strong></div>
            <div><CheckCircle2 size={16}/><span>작업 트리</span><strong>{details.dirty === null ? "정보 없음" : details.dirty ? "변경사항 있음" : "깨끗함"}</strong></div>
            <div><ShieldCheck size={16}/><span>에이전트 가이드</span><strong>{details.hasAgentsMd === null ? "정보 없음" : details.hasAgentsMd ? "확인됨" : "없음"}</strong></div>
            {details.packageHints.length > 0 && <div className="projects-hints"><span>인식된 실행 환경</span><p>{details.packageHints.join(" · ")}</p></div>}
          </div>}
          <div className="projects-detail-bottom">
            <p>등록 해제는 C2C 목록에서만 제거합니다. 로컬 폴더, Git 저장소 및 소스 파일은 삭제하지 않습니다.</p>
            <button type="button" className="projects-button danger" disabled={!canEdit}
              onClick={() => onRequestUnregister(selected.id)}>
              <Trash2 size={15}/> 등록 해제
            </button>
          </div>
        </>}

        {unregisterTarget && <div className="projects-remove" role="group" aria-label="프로젝트 등록 해제 확인">
          <h3><AlertCircle size={17}/> 등록 해제 확인</h3>
          <p>프로젝트 <strong>{unregisterTarget}</strong>를 C2C 등록 목록에서만 제거합니다. 실제 프로젝트 파일은 삭제하지 않습니다.</p>
          <label>아래에 프로젝트 ID를 그대로 입력하세요.
            <input value={unregisterTyped} onChange={e => onUnregisterTyped(e.target.value)}
              spellCheck={false} autoComplete="off" disabled={unregisterBusy}
              placeholder={unregisterTarget} aria-label="등록 해제 대상 ID 확인"/>
          </label>
          {unregisterError && <div className="projects-error" role="alert"><AlertCircle size={15}/>{unregisterError}</div>}
          <div className="projects-form-actions">
            <button type="button" className="projects-button secondary" disabled={unregisterBusy} onClick={onCancelUnregister}>취소</button>
            <button type="button" className="projects-button danger" disabled={unregisterBusy || ownedRunning || unregisterTyped !== unregisterTarget}
              onClick={onConfirmUnregister}><Trash2 size={15}/> 등록 해제</button>
          </div>
        </div>}
      </section>
    </div>
    <footer className="projects-boundary"><ShieldCheck size={15}/>
      Tauri 전용 프로젝트 목록입니다. WinForms default:7979의 프로젝트 및 인증정보는 변경하지 않습니다.
    </footer>
  </div>;
}
