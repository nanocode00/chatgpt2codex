import { useEffect, useMemo, useState } from "react";
import {
  Activity, AlertCircle, Box, CheckCircle2, ChevronRight, CircleHelp, Code2,
  Layers, LoaderCircle, Plus, Search, ShieldCheck,
  Terminal, Trash2, X
} from "lucide-react";
import {
  isNativeApp, runOwnedCliParity, type CatalogInspection,
  type OwnedCliParityOperation
} from "./runtime";
import {
  filterAfterProfileAdd, filterProfileEntries, parseProfileDetails, parseProfileTest, validateDraft,
  type ProfileDetails, type ProfileTestResult, type ProfileEntry, type ProfileKind, type ProfileFilter
} from "./profile-model";
import "./profiles.css";

type Kind = ProfileKind;
type ProfileForm = {
  alias: string;
  pythonPath: string;
  composeFile: string;
  projectName: string;
  services: string;
  controlServices: string;
};
const EMPTY_FORM: ProfileForm = {
  alias: "", pythonPath: "", composeFile: "compose.yaml",
  projectName: "", services: "", controlServices: ""
};

interface ProfilesScreenProps {
  catalog: CatalogInspection | null;
  catalogBusy: boolean;
  catalogError: string;
  onRefresh: () => Promise<void>;
  onNotify: (message: string, tone?: "info" | "error") => void;
}

function failure(error: unknown): string {
  const message = typeof error === "string" ? error :
    error instanceof Error ? error.message : "프로필 작업에 실패했습니다.";
  return message.slice(0, 420);
}

export function ProfilesScreen({
  catalog, catalogBusy, catalogError, onRefresh, onNotify
}: ProfilesScreenProps) {
  const native = isNativeApp();
  const [filter, setFilter] = useState<ProfileFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [details, setDetails] = useState<ProfileDetails | null>(null);
  const [detailsBusy, setDetailsBusy] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  const [testResult, setTestResult] = useState<ProfileTestResult | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [editorKind, setEditorKind] = useState<Kind | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);
  const [form, setForm] = useState<ProfileForm>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [revision, setRevision] = useState(0);

  const profiles = catalog?.available ? catalog.profiles : [];
  const countPython = profiles.filter(profile => profile.python).length;
  const countDocker = profiles.filter(profile => profile.docker).length;
  // Even in "All", matching aliases in Python and Docker remain distinct entries.
  const filtered = useMemo(() => filterProfileEntries(profiles, filter, query), [catalog, filter, query]);
  const selected = filtered.find(item => item.kind + ":" + item.alias === selectedKey) ?? filtered[0] ?? null;
  const selectedKind: Kind = selected?.kind ?? (filter === "docker" ? "docker" : "python");
  const total = countPython + countDocker;
  const visibleCount = filter === "all" ? total : filter === "python" ? countPython : countDocker;
  const listName = filter === "all" ? "전체" : filter === "python" ? "Python" : "Docker";
  const available = native && catalog?.available === true;
  const busy = saving || catalogBusy || detailsBusy || testBusy;

  useEffect(() => {
    if (!native || !catalog?.available || !selected) {
      setDetails(null);
      setDetailsError("");
      setDetailsBusy(false);
      setTestResult(null);
      return;
    }
    let active = true;
    setDetails(null);
    setTestResult(null);
    setDetailsError("");
    setDetailsBusy(true);
    void runOwnedCliParity({ operation: "profile-show", alias: selected.alias })
      .then(response => {
        if (!active) return;
        const parsed = parseProfileDetails(response.json, selected.alias);
        if (!parsed || (selected.kind === "python" ? !parsed.python : !parsed.docker)) {
          throw new Error("선택한 실행 환경의 상세 정보를 확인할 수 없습니다.");
        }
        setDetails(parsed);
      })
      .catch(error => { if (active) setDetailsError(failure(error)); })
      .finally(() => { if (active) setDetailsBusy(false); });
    return () => { active = false; };
  }, [native, catalog, selected?.alias, selected?.kind, revision]);

  function switchFilter(next: ProfileFilter) {
    if (next === filter) return;
    setFilter(next);
    setQuery("");
    setEditorKind(null);
    setEditingExisting(false);
    setOperationError("");
    setTestResult(null);
  }

  function chooseProfile(entry: ProfileEntry) {
    setSelectedKey(entry.kind + ":" + entry.alias);
    setEditorKind(null);
    setEditingExisting(false);
    setOperationError("");
    setTestResult(null);
  }

  function beginEditor(kind: Kind, existing = false) {
    if (existing && (!selected || selected.kind !== kind || !details)) return;
    if (!existing) {
      // The All view remains All; a specific kind view switches to the requested kind.
      setFilter(filterAfterProfileAdd(filter, kind));
      setQuery("");
    }
    setEditorKind(kind);
    setEditingExisting(existing);
    setOperationError("");
    if (existing && selected && details) {
      setForm({
        alias: selected.alias,
        pythonPath: kind === "python" ? details.python ?? "" : "",
        composeFile: kind === "docker" ? details.docker?.composeFile ?? "compose.yaml" : "compose.yaml",
        projectName: kind === "docker" ? details.docker?.projectName ?? "" : "",
        services: kind === "docker" ? details.docker?.services.join(", ") ?? "" : "",
        controlServices: kind === "docker" ? details.docker?.controlServices.join(", ") ?? "" : ""
      });
    } else {
      setForm({ ...EMPTY_FORM });
    }
  }

  function setField<K extends keyof ProfileForm>(field: K, value: ProfileForm[K]) {
    setForm(previous => ({ ...previous, [field]: value }));
    setOperationError("");
  }

  async function refresh() {
    try { await onRefresh(); }
    catch (error) { onNotify(failure(error), "error"); }
  }

  async function save() {
    if (!available || busy || !editorKind) return;
    const alias = form.alias.trim().toLowerCase();
    const values = {
      ...form, pythonPath: form.pythonPath.trim(), composeFile: form.composeFile.trim(),
      projectName: form.projectName.trim(), services: form.services.trim(),
      controlServices: form.controlServices.trim()
    };
    const issue = validateDraft(editorKind, alias, values);
    if (issue) { setOperationError(issue); return; }
    const name = editorKind === "python" ? "Python" : "Docker";
    const replaces = profiles.some(profile => profile.alias === alias && profile[editorKind]);
    if (replaces && !window.confirm(name + " 프로필 '" + alias +
      "'의 기존 설정을 교체할까요? 다른 종류의 프로필은 유지됩니다.")) return;
    setSaving(true);
    setOperationError("");
    try {
      const operation: OwnedCliParityOperation = editorKind === "python" ?
        "profile-add-python" : "profile-add-docker";
      await runOwnedCliParity({
        operation, alias,
        ...(editorKind === "python" ? { value: values.pythonPath } : {
          composeFile: values.composeFile,
          projectName: values.projectName,
          services: values.services,
          controlServices: values.controlServices
        })
      });
      setSelectedKey(editorKind + ":" + alias);
      // Retain All after a successful add as well as while the editor is open.
      setFilter(filterAfterProfileAdd(filter, editorKind));
      setQuery("");
      setEditorKind(null);
      setEditingExisting(false);
      setRevision(previous => previous + 1);
      onNotify(name + " 프로필 '" + alias + "' 등록 완료");
      await onRefresh();
    } catch (error) {
      const message = failure(error);
      setOperationError(message);
      onNotify(message, "error");
      // A write may succeed before live reload fails: refresh even after an error.
      await refresh();
    } finally { setSaving(false); }
  }

  async function inspect() {
    if (!available || busy || !selected) return;
    setTestBusy(true);
    setTestResult(null);
    setOperationError("");
    try {
      const response = await runOwnedCliParity({ operation: "profile-test", alias: selected.alias });
      const parsed = parseProfileTest(response.json, selected.alias);
      if (!parsed || (selected.kind === "python" ? !parsed.python?.configured : !parsed.docker?.configured)) {
        throw new Error("선택한 실행 환경의 검사 결과가 올바르지 않습니다.");
      }
      setTestResult(parsed);
      onNotify(selected.kind === "python" ? "Python 실행 파일 검사 완료" : "Docker 설정 확인 완료");
    } catch (error) {
      const message = failure(error);
      setOperationError(message);
      onNotify(message, "error");
    } finally { setTestBusy(false); }
  }

  async function remove() {
    if (!available || busy || !selected) return;
    const kind = selected.kind;
    const alias = selected.alias;
    const name = kind === "python" ? "Python" : "Docker";
    if (!window.confirm(name + " 프로필 '" + alias +
      "'만 등록 해제할까요? 같은 이름의 다른 실행 환경과 실제 파일은 유지됩니다.")) return;
    setSaving(true);
    setOperationError("");
    try {
      await runOwnedCliParity({
        operation: kind === "python" ? "profile-remove-python" : "profile-remove-docker",
        alias
      });
      setEditorKind(null);
      setEditingExisting(false);
      setTestResult(null);
      setSelectedKey(null);
      setRevision(previous => previous + 1);
      onNotify(name + " 프로필 '" + alias + "' 등록 해제 완료 · 파일은 유지됩니다.");
      await onRefresh();
    } catch (error) {
      const message = failure(error);
      setOperationError(message);
      onNotify(message, "error");
      await refresh();
    } finally { setSaving(false); }
  }

  const kindName = selectedKind === "python" ? "Python" : "Docker";

  return <div className="profiles-root">
    <header className="profiles-heading">
      <div>
        <p className="profiles-eyebrow">WORKSPACE / RUNTIMES</p>
        <h1>실행 환경</h1>
        <p>Python과 Docker를 각각 독립된 프로필로 관리합니다.</p>
      </div>
      <div className="profiles-header-actions">
        <button type="button" className="profiles-button primary"
          disabled={!available || saving || testBusy}
          onClick={() => beginEditor("python")}><Plus size={16}/> Python 추가</button>
        <button type="button" className="profiles-button primary"
          disabled={!available || saving || testBusy}
          onClick={() => beginEditor("docker")}><Plus size={16}/> Docker 추가</button>
      </div>
    </header>

    <div id="profiles-kind-content" className="profiles-content">
      <section className="profiles-stats" role="group" aria-label="프로필 목록 필터">
        <button type="button" className={filter === "all" ? "active" : ""}
          aria-pressed={filter === "all"} disabled={saving || testBusy}
          onClick={() => switchFilter("all")}>
          <Layers size={16}/><strong>{available ? total : "—"}</strong><span>전체</span>
        </button>
        <button type="button" className={filter === "python" ? "active" : ""}
          aria-pressed={filter === "python"} disabled={saving || testBusy}
          onClick={() => switchFilter("python")}>
          <Code2 size={16}/><strong>{available ? countPython : "—"}</strong><span>Python</span>
        </button>
        <button type="button" className={filter === "docker" ? "active" : ""}
          aria-pressed={filter === "docker"} disabled={saving || testBusy}
          onClick={() => switchFilter("docker")}>
          <Box size={16}/><strong>{available ? countDocker : "—"}</strong><span>Docker</span>
        </button>
      </section>

      {catalogError && <div className="profiles-error" role="alert"><AlertCircle size={16}/>{catalogError}</div>}
      {catalog && !catalog.available && <div className="profiles-note" role="status">
        <CircleHelp size={16}/> Tauri 전용 CLI의 실행 환경 목록을 읽을 수 없습니다. 런타임 상태를 확인하세요.
      </div>}

      {editorKind !== null && <section className="profiles-editor" aria-labelledby="profiles-editor-title">
        <div className="profiles-panel-heading">
          <div>
            <p>{editorKind === "python" ? "PYTHON PROFILE" : "DOCKER PROFILE"}</p>
            <h2 id="profiles-editor-title">{editorKind === "python" ? "Python" : "Docker"} {editingExisting ? "설정 교체" : "프로필 등록"}</h2>
          </div>
          <button type="button" className="profiles-icon-button" disabled={saving}
            onClick={() => setEditorKind(null)} aria-label="편집 닫기"><X size={17}/></button>
        </div>
        <form className="profiles-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <label>프로필 별칭
            <input value={form.alias} maxLength={64} spellCheck={false} autoComplete="off"
              readOnly={editingExisting} disabled={saving}
              onChange={event => setField("alias", event.target.value)} placeholder="예: local-dev"/>
          </label>
          <p className="profiles-hint">
            {editingExisting ? "기존 프로필 설정을 변경합니다. 별칭을 바꾸려면 새 프로필을 등록하세요." :
              "동일한 별칭이 다른 종류에 있어도 별도 프로필로 등록됩니다."}
          </p>
          {editorKind === "python" ? <>
            <label>Python 실행 파일의 절대 경로
              <input value={form.pythonPath} disabled={saving} maxLength={512} spellCheck={false}
                onChange={event => setField("pythonPath", event.target.value)}
                placeholder={"C:\\Users\\me\\miniconda3\\envs\\dev\\python.exe"}/>
            </label>
            <p className="profiles-hint">현재 존재하는 python.exe를 지정합니다. 등록 시 CLI가 실행 가능 여부를 확인합니다.</p>
          </> : <>
            <label>Docker Compose 파일 (프로젝트 상대 경로)
              <input value={form.composeFile} disabled={saving} maxLength={512} spellCheck={false}
                onChange={event => setField("composeFile", event.target.value)} placeholder="compose.yaml"/>
            </label>
            <div className="profiles-form-grid">
              <label>Compose 프로젝트 이름
                <input value={form.projectName} disabled={saving} maxLength={80} spellCheck={false}
                  onChange={event => setField("projectName", event.target.value)} placeholder="my-app"/>
              </label>
              <label>서비스 (쉼표 구분)
                <input value={form.services} disabled={saving} maxLength={512} spellCheck={false}
                  onChange={event => setField("services", event.target.value)} placeholder="api,db"/>
              </label>
            </div>
            <label>제어 서비스 (선택)
              <input value={form.controlServices} disabled={saving} maxLength={512} spellCheck={false}
                onChange={event => setField("controlServices", event.target.value)} placeholder="api"/>
            </label>
            <p className="profiles-hint">Docker 설정만 등록합니다. 데몬 접속이나 컨테이너 실행은 수행하지 않습니다.</p>
          </>}
          {operationError && <div className="profiles-error" role="alert"><AlertCircle size={15}/>{operationError}</div>}
          <div className="profiles-form-actions">
            <button type="button" className="profiles-button secondary" disabled={saving}
              onClick={() => { setEditorKind(null); setOperationError(""); }}>취소</button>
            <button type="submit" className="profiles-button primary" disabled={!available || saving}>
              {saving && <LoaderCircle size={15} className="profiles-spinning"/>}
              {editingExisting ? (editorKind === "python" ? "Python" : "Docker") + " 설정 저장" : (editorKind === "python" ? "Python" : "Docker") + " 등록"}
            </button>
          </div>
        </form>
      </section>}

      <div className="profiles-layout">
        <section className="profiles-list-panel" aria-labelledby="profiles-list-heading">
          <div className="profiles-panel-heading">
            <div><p>CONFIGURED PROFILES</p><h2 id="profiles-list-heading">{listName} 프로필 목록</h2></div>
            <span className="profiles-count">{filtered.length} / {visibleCount}</span>
          </div>
          <div className="profiles-search">
            <Search size={16}/>
            <input aria-label={listName + " 프로필 별칭 검색"} value={query}
              placeholder={listName + " 별칭 검색"} disabled={saving || testBusy}
              onChange={event => setQuery(event.target.value)}/>
            {query && <button type="button" aria-label="검색 지우기"
              onClick={() => setQuery("")}><X size={15}/></button>}
          </div>
          <div className="profiles-items" role="region" aria-label={listName + " 프로필 목록 스크롤 영역"} tabIndex={0}>
            {filtered.length === 0 && <div className="profiles-empty">
              <Layers size={25}/>
              <strong>{visibleCount ? "검색 결과가 없습니다." : listName + " 프로필이 없습니다."}</strong>
              <span>Python 추가 또는 Docker 추가 버튼으로 새 프로필을 등록할 수 있습니다.</span>
            </div>}
            {filtered.map(profile => <button type="button" key={profile.kind + ":" + profile.alias}
              className={"profiles-item " + (selected?.kind === profile.kind && selected?.alias === profile.alias ? "selected" : "")}
              aria-pressed={selected?.kind === profile.kind && selected?.alias === profile.alias}
              disabled={saving || testBusy} onClick={() => chooseProfile(profile)}>
              <span className="profiles-item-icon">
                {profile.kind === "python" ? <Terminal size={17}/> : <Box size={17}/>}
              </span>
              <span className="profiles-item-name"><strong>{profile.alias}</strong>
                <small>{profile.kind === "python" ? "Python" : "Docker"} 실행 환경</small>
              </span>
              <ChevronRight size={15}/>
            </button>)}
          </div>
        </section>

        <section className="profiles-detail-panel" aria-labelledby="profiles-detail-title">
          <div className="profiles-panel-heading">
            <div><p>PROFILE INSPECTOR</p><h2 id="profiles-detail-title">{kindName} 상세</h2></div>
            {selected && <button type="button" className="profiles-button secondary"
              disabled={!available || busy} onClick={() => { void inspect(); }}>
              <Activity size={15}/>{testBusy ? "검사 중..." :
                selectedKind === "python" ? "실행 파일 검사" : "설정 확인"}</button>}
          </div>
          {!selected ? <div className="profiles-empty profiles-inspector-empty">
            <Layers size={27}/><strong>조회할 {kindName} 프로필을 선택하세요.</strong>
            <span>왼쪽 목록에서 선택하거나 새 프로필을 등록하세요.</span>
          </div> : <>
            <div className="profiles-selected">
              <div className="profiles-selected-icon">
                {selectedKind === "python" ? <Code2 size={20}/> : <Box size={20}/>}
              </div>
              <div><h3>{selected.alias}</h3><p>{kindName} 프로필</p></div>
            </div>
            {detailsBusy && <p className="profiles-hint profiles-loading">
              <LoaderCircle size={14} className="profiles-spinning"/> 등록 정보를 확인하는 중입니다.
            </p>}
            {detailsError && <div className="profiles-error" role="alert">
              <AlertCircle size={15}/>{detailsError}
            </div>}

            <div className="profiles-main-runtime">
              <div className="profiles-kind-panel profiles-kind-focused">
                {selectedKind === "python" ? <>
                  <div className="profiles-kind-title">
                    <Code2 size={18}/><strong>Python 실행 환경</strong><span>등록됨</span>
                  </div>
                  <div className="profiles-detail-field">
                    <p className="profiles-field-label">실행 파일</p>
                    <code className="profiles-path">{details?.python ?? (detailsBusy ? "조회 중..." : "상세 확인 필요")}</code>
                  </div>
                  <p className="profiles-kind-description">Python 실행 파일의 가용성과 버전을 확인할 수 있습니다.</p>
                </> : <>
                  <div className="profiles-kind-title">
                    <Box size={18}/><strong>Docker Compose 실행 환경</strong><span>등록됨</span>
                  </div>
                  <div className="profiles-detail-field">
                    <p className="profiles-field-label">Compose 파일</p>
                    <code className="profiles-path">{details?.docker?.composeFile ??
                      (detailsBusy ? "조회 중..." : "상세 확인 필요")}</code>
                  </div>
                  <div className="profiles-docker-fields">
                    <div><span>Compose 프로젝트</span><strong>{details?.docker?.projectName ?? "정보 없음"}</strong></div>
                    <div><span>서비스</span><strong>{details?.docker?.services.join(", ") || "정보 없음"}</strong></div>
                    <div><span>제어 서비스</span><strong>{details?.docker?.controlServices.join(", ") || "지정되지 않음"}</strong></div>
                  </div>
                  <p className="profiles-kind-description">Docker 설정 검사만 지원합니다. 데몬·컨테이너 실행 여부는 확인하지 않습니다.</p>
                </>}
                <div className="profiles-card-actions">
                  <button type="button" className="profiles-button secondary"
                    disabled={!available || busy || !details} onClick={() => beginEditor(selectedKind, true)}>
                    {kindName} 설정 / 교체
                  </button>
                  <button type="button" className="profiles-button danger"
                    disabled={!available || busy} onClick={() => { void remove(); }}>
                    <Trash2 size={14}/> {kindName} 제거
                  </button>
                </div>
              </div>
            </div>

            {testResult && <div className="profiles-test-result" role="status">
              <div><CheckCircle2 size={16}/><strong>{kindName} 검사 결과</strong></div>
              {selectedKind === "python" ? <p>
                {testResult.python?.available === true ? "실행 파일 확인됨" :
                  testResult.python?.available === false ? "실행 파일 확인 실패" : "실행 파일 상태 미확인"}
                {testResult.python?.version ? " · " + testResult.python.version : ""}
              </p> : <p>
                {testResult.docker?.valid === true ? "설정 형식 확인됨 (데몬·컨테이너 미검사)" :
                  "설정 검증 필요"}
              </p>}
            </div>}
            {operationError && editorKind === null && <div className="profiles-error" role="alert">
              <AlertCircle size={15}/>{operationError}
            </div>}
            <div className="profiles-remove-area">
              <p>{kindName} 등록만 제거합니다. 다른 종류의 동일 별칭 프로필과 실제 설치·파일은 유지됩니다.</p>
            </div>
          </>}
        </section>
      </div>
    </div>
    <div className="profiles-boundary"><ShieldCheck size={16}/>
      Python·Docker 프로필은 독립적으로 관리합니다. 실제 Python 및 Docker 설치 환경을 제거하지 않습니다.
    </div>
  </div>;
}
