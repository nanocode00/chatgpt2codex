import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Box, CheckCircle2, ChevronRight, CircleHelp, Code2,
  Layers, LoaderCircle, Plus, RefreshCcw, Search, Settings2, ShieldCheck,
  Terminal, Trash2, X
} from "lucide-react";
import { isNativeApp, runOwnedCliParity, type CatalogInspection, type CatalogProfile, type OwnedCliParityOperation } from "./runtime";
import { filterProfiles, parseProfileDetails, parseProfileTest, validateProfileSelection,
  type ProfileDetails, type ProfileTestResult } from "./profile-model";
import "./profiles.css";

type Kind = "python" | "docker";
type Form = {
  alias: string;
  pythonPath: string;
  composeFile: string;
  projectName: string;
  services: string;
  controlServices: string;
};
const BLANK: Form = { alias: "", pythonPath: "", composeFile: "compose.yaml", projectName: "",
  services: "", controlServices: "" };

interface ProfilesScreenProps {
  catalog: CatalogInspection | null;
  catalogBusy: boolean;
  catalogError: string;
  onRefresh: () => Promise<void>;
  onNotify: (message: string, tone?: "info" | "error") => void;
}

function failure(error: unknown): string {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "프로필 작업에 실패했습니다.";
  return message.slice(0, 420);
}

export function ProfilesScreen({ catalog, catalogBusy, catalogError, onRefresh, onNotify }: ProfilesScreenProps) {
  const native = isNativeApp();
  const [query, setQuery] = useState("");
  const [selectedAlias, setSelectedAlias] = useState<string | null>(null);
  const [activeKind, setActiveKind] = useState<Kind>("python");
  const [detail, setDetail] = useState<ProfileDetails | null>(null);
  const [detailError, setDetailError] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [result, setResult] = useState<ProfileTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [editorKind, setEditorKind] = useState<Kind | null>(null);
  const [includePython, setIncludePython] = useState(true);
  const [includeDocker, setIncludeDocker] = useState(false);
  const [form, setForm] = useState<Form>(BLANK);
  const [saving, setSaving] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [removeAll, setRemoveAll] = useState(false);
  const [removeTyped, setRemoveTyped] = useState("");
  const [revision, setRevision] = useState(0);

  const items = catalog?.available ? catalog.profiles : [];
  const filtered = useMemo(() => filterProfiles(items, query), [items, query]);
  const selected = filtered.find(p => p.alias === selectedAlias) ?? filtered[0] ?? null;
  const visibleKind: Kind = selected?.python && selected?.docker ? activeKind : selected?.docker ? "docker" : "python";
  const countPython = items.filter(p => p.python).length;
  const countDocker = items.filter(p => p.docker).length;
  const busy = saving || testBusy || detailBusy || catalogBusy;
  const available = native && catalog?.available === true;

  // Read only the exact chosen alias. Late responses cannot overwrite the new selection.
  useEffect(() => {
    if (!native || !catalog?.available || !selected) {
      setDetail(null); setDetailError(""); setDetailBusy(false); setResult(null);
      return;
    }
    let active = true;
    setDetail(null); setResult(null); setDetailError(""); setDetailBusy(true);
    void runOwnedCliParity({ operation: "profile-show", alias: selected.alias })
      .then(reply => {
        if (!active) return;
        const parsed = parseProfileDetails(reply.json, selected.alias);
        if (!parsed) throw new Error("CLI 프로필 상세 형식을 확인할 수 없습니다.");
        setDetail(parsed);
      })
      .catch(error => { if (active) setDetailError(failure(error)); })
      .finally(() => { if (active) setDetailBusy(false); });
    return () => { active = false; };
  }, [native, catalog, selected?.alias, revision]);

  function selectProfile(item: CatalogProfile) {
    setSelectedAlias(item.alias);
    setActiveKind(item.python ? "python" : "docker");
    setEditorKind(null);
    setRemoveAll(false); setRemoveTyped("");
    setResult(null); setOperationError("");
  }

  function beginEditor(kind: Kind, existing = false) {
    setRemoveAll(false); setRemoveTyped("");
    setOperationError("");
    setEditorKind(kind);
    setIncludePython(kind === "python");
    setIncludeDocker(kind === "docker");
    if (existing && selected) {
      setForm({
        alias: selected.alias,
        pythonPath: detail?.python ?? "",
        composeFile: detail?.docker?.composeFile ?? "compose.yaml",
        projectName: detail?.docker?.projectName ?? "",
        services: detail?.docker?.services.join(", ") ?? "",
        controlServices: detail?.docker?.controlServices.join(", ") ?? ""
      });
    } else {
      setForm({ ...BLANK });
    }
  }

  async function refresh() {
    try { await onRefresh(); }
    catch (error) { onNotify(failure(error), "error"); }
  }

  async function save() {
    if (!available || busy || !editorKind) return;
    const alias = form.alias.trim().toLowerCase();
    const values = { ...form, pythonPath: form.pythonPath.trim(), composeFile: form.composeFile.trim(),
      projectName: form.projectName.trim(), services: form.services.trim(), controlServices: form.controlServices.trim() };
    const issue = validateProfileSelection(alias, values, { python: includePython, docker: includeDocker });
    if (issue) { setOperationError(issue); return; }
    const exists = items.find(p => p.alias === alias);
    const replacing = [
      includePython && exists?.python ? "Python" : "",
      includeDocker && exists?.docker ? "Docker" : ""
    ].filter(Boolean);
    if (replacing.length && !window.confirm("프로필 '" + alias + "'의 " + replacing.join("·") +
      " 설정을 교체할까요? 선택하지 않은 실행 환경은 유지됩니다.")) return;
    setSaving(true); setOperationError("");
    try {
      const operation: OwnedCliParityOperation = includePython && includeDocker ? "profile-add-both" :
        includePython ? "profile-add-python" : "profile-add-docker";
      // A combined selection is one CLI invocation, not two partial writes.
      await runOwnedCliParity({
        operation, alias,
        ...(includePython ? { value: values.pythonPath } : {}),
        ...(includeDocker ? {
          composeFile: values.composeFile, projectName: values.projectName,
          services: values.services, controlServices: values.controlServices
        } : {})
      });
      setQuery(""); setSelectedAlias(alias); setActiveKind(includePython ? "python" : "docker");
      setEditorKind(null); setRevision(v => v + 1);
      onNotify((includePython && includeDocker ? "Python·Docker" : includePython ? "Python" : "Docker") +
        " 프로필 설정을 저장했습니다.");
      await onRefresh();
    } catch (error) {
      const message = failure(error);
      setOperationError(message); onNotify(message, "error");
      // A CLI write may have succeeded before live reload failed: do not show a stale catalog.
      await refresh();
    } finally { setSaving(false); }
  }

  async function test() {
    if (!available || busy || !selected) return;
    setTestBusy(true); setOperationError(""); setResult(null);
    try {
      const reply = await runOwnedCliParity({ operation: "profile-test", alias: selected.alias });
      const parsed = parseProfileTest(reply.json, selected.alias);
      if (!parsed) throw new Error("CLI 검사 결과의 형식이 올바르지 않습니다.");
      setResult(parsed);
      onNotify("프로필 검사 결과를 갱신했습니다.");
    } catch (error) {
      const message = failure(error);
      setOperationError(message); onNotify(message, "error");
    } finally { setTestBusy(false); }
  }

  async function remove(kind: Kind | "all") {
    if (!available || busy || !selected) return;
    if (kind === "all") {
      if (!removeAll || removeTyped !== selected.alias) return;
    } else if (!window.confirm("'" + selected.alias + "'에서 " + (kind === "python" ? "Python" : "Docker") +
        " 프로필만 제거할까요? 다른 종류의 프로필은 유지됩니다.")) return;
    setSaving(true); setOperationError("");
    const alias = selected.alias;
    try {
      const operation: OwnedCliParityOperation = kind === "all" ? "profile-remove-all" :
        kind === "python" ? "profile-remove-python" : "profile-remove-docker";
      await runOwnedCliParity({ operation, alias });
      setEditorKind(null); setRemoveAll(false); setRemoveTyped(""); setResult(null);
      setRevision(v => v + 1);
      onNotify("프로필 등록을 해제했습니다. 로컬 실행 파일이나 Docker 파일은 삭제하지 않았습니다.");
      await onRefresh();
    } catch (error) {
      const message = failure(error);
      setOperationError(message); onNotify(message, "error");
      await refresh();
    } finally { setSaving(false); }
  }

  function setValue<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(previous => ({ ...previous, [key]: value }));
    setOperationError("");
  }

  return <div className="profiles-root">
    <header className="profiles-heading">
      <div>
        <p className="profiles-eyebrow">WORKSPACE / RUNTIMES</p>
        <h1>실행 환경</h1>
        <p>프로젝트 작업에 사용할 Python과 Docker 프로필을 등록하고 관리합니다.</p>
      </div>
      <div className="profiles-header-actions">
        <button type="button" className="profiles-button secondary" disabled={!native || catalogBusy || saving}
          onClick={() => { void refresh(); }}><RefreshCcw size={16}/> 새로고침</button>
        <button type="button" className="profiles-button primary" disabled={!available || saving}
          onClick={() => beginEditor("python")}><Plus size={16}/> 프로필 추가</button>
      </div>
    </header>

    <section className="profiles-stats" aria-label="프로필 현황">
      <div><Layers size={16}/><strong>{available ? items.length : "—"}</strong><span>프로필 별칭</span></div>
      <div><Code2 size={16}/><strong>{available ? countPython : "—"}</strong><span>Python 등록</span></div>
      <div><Box size={16}/><strong>{available ? countDocker : "—"}</strong><span>Docker 등록</span></div>
    </section>

    {catalogError && <div className="profiles-error" role="alert"><AlertCircle size={16}/>{catalogError}</div>}
    {catalog && !catalog.available && <div className="profiles-note" role="status">
      <CircleHelp size={16}/> Tauri 전용 CLI의 프로필 목록을 읽을 수 없습니다. 런타임 상태를 확인하세요.
    </div>}

    {editorKind !== null && <section className="profiles-editor" aria-labelledby="profiles-editor-title">
      <div className="profiles-panel-heading">
        <div><p>PROFILE EDITOR</p><h2 id="profiles-editor-title">프로필 {items.some(p => p.alias === form.alias) ? "등록 / 교체" : "추가"}</h2></div>
        <button type="button" className="profiles-icon-button" onClick={() => setEditorKind(null)}
          disabled={saving} aria-label="편집 닫기"><X size={17}/></button>
      </div>
      <form className="profiles-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label>프로필 별칭
          <input value={form.alias} disabled={saving} maxLength={64} spellCheck={false}
            onChange={event => setValue("alias", event.target.value)} placeholder="예: local-dev"/>
        </label>
        <p className="profiles-hint">사용할 실행 환경을 하나 이상 선택하세요. Python과 Docker를 둘 다 선택하면 같은 별칭으로 한 번에 등록합니다. 선택하지 않은 기존 설정은 유지됩니다.</p>
        <div className="profiles-form-kind-grid">
          <section className={"profiles-form-kind " + (includePython ? "active" : "")}>
            <label className="profiles-kind-toggle">
              <input type="checkbox" checked={includePython} disabled={saving}
                onChange={event => { setIncludePython(event.target.checked); setOperationError(""); }}/>
              <span><strong><Code2 size={16}/> Python</strong><small>로컬 python.exe 실행 환경</small></span>
            </label>
            {includePython && <div className="profiles-kind-fields">
              <label>Python 실행 파일의 절대 경로
                <input value={form.pythonPath} disabled={saving} maxLength={512} spellCheck={false}
                  onChange={event => setValue("pythonPath", event.target.value)}
                  placeholder={"C:\\Users\\me\\miniconda3\\envs\\dev\\python.exe"}/>
              </label>
              <p className="profiles-hint">등록 시 CLI가 Python 실행 가능 여부를 확인합니다.</p>
            </div>}
          </section>
          <section className={"profiles-form-kind " + (includeDocker ? "active" : "")}>
            <label className="profiles-kind-toggle">
              <input type="checkbox" checked={includeDocker} disabled={saving}
                onChange={event => { setIncludeDocker(event.target.checked); setOperationError(""); }}/>
              <span><strong><Box size={16}/> Docker</strong><small>Compose 서비스 구성</small></span>
            </label>
            {includeDocker && <div className="profiles-kind-fields">
              <label>Docker Compose 파일 (상대 경로)
                <input value={form.composeFile} disabled={saving} maxLength={512} spellCheck={false}
                  onChange={event => setValue("composeFile", event.target.value)} placeholder="compose.yaml"/>
              </label>
              <label>Compose 프로젝트 이름
                <input value={form.projectName} disabled={saving} maxLength={80} spellCheck={false}
                  onChange={event => setValue("projectName", event.target.value)} placeholder="my-app"/>
              </label>
              <label>서비스 (쉼표 구분)
                <input value={form.services} disabled={saving} maxLength={512} spellCheck={false}
                  onChange={event => setValue("services", event.target.value)} placeholder="api,db"/>
              </label>
              <label>제어 서비스 (선택)
                <input value={form.controlServices} disabled={saving} maxLength={512} spellCheck={false}
                  onChange={event => setValue("controlServices", event.target.value)} placeholder="api"/>
              </label>
              <p className="profiles-hint">Docker는 설정을 저장하며, 실제 Docker 데몬·컨테이너는 실행하거나 검사하지 않습니다.</p>
            </div>}
          </section>
        </div>
        {operationError && <div className="profiles-error" role="alert"><AlertCircle size={15}/>{operationError}</div>}
        <div className="profiles-form-actions">
          <button type="button" className="profiles-button secondary" disabled={saving}
            onClick={() => { setEditorKind(null); setOperationError(""); }}>취소</button>
          <button type="submit" className="profiles-button primary" disabled={!available || saving}>
            {saving && <LoaderCircle size={15} className="profiles-spinning"/>} {items.some(p => p.alias === form.alias) ? "등록 / 교체" : "프로필 등록"}
          </button>
        </div>
      </form>
    </section>}

    <div className="profiles-layout">
      <section className="profiles-list-panel" aria-labelledby="profiles-list-heading">
        <div className="profiles-panel-heading">
          <div><p>CONFIGURED PROFILES</p><h2 id="profiles-list-heading">프로필 목록</h2></div>
          <span className="profiles-count">{filtered.length} / {items.length}</span>
        </div>
        <div className="profiles-search">
          <Search size={16}/>
          <input aria-label="프로필 별칭 검색" value={query} placeholder="프로필 별칭 검색"
            onChange={e => setQuery(e.target.value)}/>
          {query && <button type="button" aria-label="검색 지우기" onClick={() => setQuery("")}><X size={15}/></button>}
        </div>
        <div className="profiles-items" role="region" aria-label="프로필 목록 스크롤 영역" tabIndex={0}>
          {filtered.length === 0 && <div className="profiles-empty">
            <Layers size={25}/><strong>{items.length ? "검색 결과가 없습니다." : "등록된 프로필이 없습니다."}</strong>
            <span>프로필 추가 버튼으로 Python 또는 Docker 실행 환경을 등록하세요.</span>
          </div>}
          {filtered.map(profile => <button type="button" className={"profiles-item " +
            (selected?.alias === profile.alias ? "selected" : "")} aria-pressed={selected?.alias === profile.alias}
            key={profile.alias} onClick={() => selectProfile(profile)}>
            <span className="profiles-item-icon"><Terminal size={17}/></span>
            <span className="profiles-item-name"><strong>{profile.alias}</strong><small>
              {[profile.python && "Python", profile.docker && "Docker"].filter(Boolean).join(" · ")}
            </small></span>
            <ChevronRight size={15}/>
          </button>)}
        </div>
      </section>

      <section className="profiles-detail-panel" aria-labelledby="profiles-detail-title">
        <div className="profiles-panel-heading">
          <div><p>PROFILE INSPECTOR</p><h2 id="profiles-detail-title">프로필 상세</h2></div>
          {selected && <button type="button" className="profiles-button secondary"
            disabled={!available || busy} onClick={() => { void test(); }}>
            <Activity size={15}/>{testBusy ? "검사 중..." : "설정 검사"}</button>}
        </div>
        {!selected ? <div className="profiles-empty profiles-inspector-empty">
          <Layers size={27}/><strong>조회할 프로필을 선택하세요.</strong>
          <span>Python 또는 Docker 프로필을 등록하면 여기서 관리할 수 있습니다.</span>
        </div> : <>
          <div className="profiles-selected">
            <div className="profiles-selected-icon"><Settings2 size={20}/></div>
            <div><h3>{selected.alias}</h3><p>
              {[selected.python && "Python", selected.docker && "Docker"].filter(Boolean).join(" · ")} 프로필
            </p></div>
          </div>
          {detailBusy && <p className="profiles-hint profiles-loading"><LoaderCircle size={14} className="profiles-spinning"/> 등록 정보를 확인하는 중입니다.</p>}
          {detailError && <div className="profiles-error" role="alert"><AlertCircle size={15}/>{detailError}</div>}
          {selected.python && selected.docker && <div className="profiles-detail-switch" role="group" aria-label="상세 실행 환경 선택">
            <button type="button" aria-pressed={visibleKind === "python"} className={visibleKind === "python" ? "active" : ""}
              onClick={() => setActiveKind("python")}><Code2 size={15}/> Python</button>
            <button type="button" aria-pressed={visibleKind === "docker"} className={visibleKind === "docker" ? "active" : ""}
              onClick={() => setActiveKind("docker")}><Box size={15}/> Docker</button>
          </div>}

          <div className="profiles-main-runtime">
            <div className="profiles-kind-panel profiles-kind-focused">
              {visibleKind === "python" ? <>
                <div className="profiles-kind-title">
                  <Code2 size={18}/><strong>Python 실행 환경</strong><span>등록됨</span>
                </div>
                <div className="profiles-detail-field">
                  <p className="profiles-field-label">Python 실행 파일</p>
                  <code className="profiles-path">{detail?.python ?? (detailBusy ? "조회 중..." : "상세 확인 필요")}</code>
                </div>
                <p className="profiles-kind-description">설정 검사는 등록된 Python 실행 파일의 가용성과 버전을 확인합니다.</p>
                <div className="profiles-card-actions">
                  <button type="button" className="profiles-button secondary" disabled={!available || busy || !detail}
                    onClick={() => beginEditor("python", true)}>Python 설정 / 교체</button>
                  <button type="button" className="profiles-button danger" disabled={!available || busy}
                    onClick={() => { void remove("python"); }}><Trash2 size={14}/> Python 제거</button>
                </div>
              </> : <>
                <div className="profiles-kind-title">
                  <Box size={18}/><strong>Docker Compose 실행 환경</strong><span>등록됨</span>
                </div>
                <div className="profiles-detail-field">
                  <p className="profiles-field-label">Compose 파일</p>
                  <code className="profiles-path">{detail?.docker?.composeFile ?? (detailBusy ? "조회 중..." : "상세 확인 필요")}</code>
                </div>
                <div className="profiles-docker-fields">
                  <div><span>Compose 프로젝트</span><strong>{detail?.docker?.projectName ?? "정보 없음"}</strong></div>
                  <div><span>서비스</span><strong>{detail?.docker?.services.join(", ") || "정보 없음"}</strong></div>
                  <div><span>제어 서비스</span><strong>{detail?.docker?.controlServices.join(", ") || "지정되지 않음"}</strong></div>
                </div>
                <p className="profiles-kind-description">설정 검사는 등록된 값만 확인합니다. Docker 데몬 연결이나 컨테이너 실행 여부를 검사하지 않습니다.</p>
                <div className="profiles-card-actions">
                  <button type="button" className="profiles-button secondary" disabled={!available || busy || !detail}
                    onClick={() => beginEditor("docker", true)}>Docker 설정 / 교체</button>
                  <button type="button" className="profiles-button danger" disabled={!available || busy}
                    onClick={() => { void remove("docker"); }}><Trash2 size={14}/> Docker 제거</button>
                </div>
              </>}
            </div>
          </div>
          {selected.python !== selected.docker && <div className="profiles-secondary-kind">
            <div><strong>{selected.python ? "Docker" : "Python"}도 같은 별칭에 추가할 수 있어요.</strong>
              <p>현재 프로필 설정을 유지하면서 다른 실행 환경을 추가합니다.</p>
            </div>
            <button type="button" className="profiles-button secondary" disabled={!available || busy}
              onClick={() => beginEditor(selected.python ? "docker" : "python", true)}>
              <Plus size={15}/> {selected.python ? "Docker 추가" : "Python 추가"}
            </button>
          </div>}

          {result && <div className="profiles-test-result" role="status">
            <div><CheckCircle2 size={16}/><strong>CLI 검사 결과</strong></div>
            <p>Python: {result.python?.configured ? result.python.available === true
              ? "실행 파일 확인됨" : result.python.available === false ? "실행 파일 확인 실패" : "확인 결과 없음" : "미등록"}
              {result.python?.version ? " · " + result.python.version : ""}</p>
            <p>Docker: {result.docker?.configured ? result.docker.valid === true
              ? "설정 형식 확인됨 (데몬·컨테이너 미검사)" : "설정 검증 필요" : "미등록"}</p>
          </div>}
          {operationError && editorKind === null && <div className="profiles-error" role="alert"><AlertCircle size={15}/>{operationError}</div>}
          <div className="profiles-remove-area">
            <p>프로필을 제거해도 Python 설치나 Docker Compose 파일은 삭제되지 않습니다.</p>
            {!removeAll ? <button type="button" className="profiles-button danger" disabled={!available || busy}
              onClick={() => { setRemoveAll(true); setRemoveTyped(""); }}>별칭 전체 제거</button> :
              <div className="profiles-remove-confirm">
                <strong>프로필 '{selected.alias}' 전체 제거</strong>
                <p>Python과 Docker 설정을 모두 해제합니다. 별칭을 정확히 입력하세요.</p>
                <input value={removeTyped} disabled={saving} autoComplete="off" spellCheck={false}
                  onChange={event => setRemoveTyped(event.target.value)} placeholder={selected.alias}
                  aria-label="전체 제거 대상 별칭 확인"/>
                <div className="profiles-form-actions">
                  <button type="button" className="profiles-button secondary" onClick={() => setRemoveAll(false)}
                    disabled={saving}>취소</button>
                  <button type="button" className="profiles-button danger" disabled={!available || busy || removeTyped !== selected.alias}
                    onClick={() => { void remove("all"); }}><Trash2 size={14}/> 전체 제거</button>
                </div>
              </div>}
          </div>
        </>}
      </section>
    </div>
    <div className="profiles-boundary"><ShieldCheck size={16}/>
      SHA 검증된 Tauri 전용 CLI만 사용합니다. 기존 WinForms/7979 설정과 실행 환경은 변경하지 않으며,
      별칭을 새로 등록해도 전역 기본 프로필이 자동 선택되지는 않습니다.
    </div>
  </div>;
}
