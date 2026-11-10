import { useEffect, useState } from "react";
import { RefreshCcw, TerminalSquare, Settings2, Activity, Layers, Play, Trash2, CircleAlert } from "lucide-react";
import { isNativeApp, runOwnedCliParity, type OwnedCliParityRequest, type OwnedCliParityOperation, type OwnedCliParityResponse } from "./runtime";
import { parseJobList, type JobListItem } from "./job-list";

type Profile = { alias: string; python: boolean; docker: boolean };
type Group = "profiles" | "config" | "operations" | "advanced";

function parseProfiles(result: OwnedCliParityResponse): Profile[] {
  const value = result.json as { profiles?: unknown } | null;
  if (!Array.isArray(value?.profiles)) return [];
  return value.profiles.filter((row): row is Profile =>
    !!row && typeof row.alias === "string" && typeof row.python === "boolean" &&
    typeof row.docker === "boolean").slice(0, 128);
}

/** Validate on click instead of disabling controls based on unsaved form fields.
 * Native Rust validation remains authoritative (paths, IDs, allowed commands).
 */
function missingInput(request: OwnedCliParityRequest): string | null {
  const operation = request.operation;
  if (operation.startsWith("profile-") && operation !== "profile-list" &&
      !request.alias?.trim()) {
    return "프로필 별칭을 먼저 입력하거나 목록에서 선택하세요.";
  }
  if (operation === "profile-add-python" && !request.value?.trim()) {
    return "등록할 Python의 python.exe 절대 경로를 입력하세요.";
  }
  if (operation === "profile-add-docker") {
    if (!request.composeFile?.trim()) return "Docker Compose 파일의 상대 경로를 입력하세요.";
    if (!request.projectName?.trim()) return "Docker Compose 프로젝트 이름을 입력하세요.";
    if (!request.services?.trim()) return "Docker 서비스 이름을 하나 이상 입력하세요.";
  }
  if (operation === "repository-show" && !request.target?.trim()) {
    return "조회할 프로젝트 ID를 입력하세요.";
  }
  if ((operation === "job-status" || operation === "job-logs") &&
      !/^loop-[A-Za-z0-9.-]+$/.test(request.target?.trim() ?? "")) {
    return "유효한 작업 ID(loop-...)가 필요합니다. 먼저 job list에서 작업을 확인하세요. 프로젝트 ID로는 조회할 수 없습니다.";
  }
  return null;
}

const GROUPS: { key: Group; title: string; subtitle: string }[] = [
  { key: "profiles", title: "프로필", subtitle: "profile list / show / add / remove / test" },
  { key: "config", title: "설정", subtitle: "config show / set / unset / export" },
  { key: "operations", title: "진단·재로드", subtitle: "status / health / doctor / logs / reload" },
  { key: "advanced", title: "추가 조회", subtitle: "repository / secret / job / lock / control" }
];

export function CliParityPanel() {
  const native = isNativeApp();
  const [group, setGroup] = useState<Group>("profiles");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnedCliParityResponse | null>(null);
  const [error, setError] = useState("");
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [alias, setAlias] = useState("");
  const [pythonPath, setPythonPath] = useState("");
  const [composeFile, setComposeFile] = useState("compose.yaml");
  const [projectName, setProjectName] = useState("");
  const [services, setServices] = useState("");
  const [controlServices, setControlServices] = useState("");
  const [target, setTarget] = useState("");
  const [jobs, setJobs] = useState<JobListItem[] | null>(null);
  const [configKey, setConfigKey] = useState("port");
  const [configValue, setConfigValue] = useState("18797");

  useEffect(() => {
    if (!native) return;
    let active = true;
    void runOwnedCliParity({ operation: "profile-list" }).then(reply => {
      if (active) setProfiles(parseProfiles(reply));
    }).catch(() => { /* The explicit command button displays errors. */ });
    return () => { active = false; };
  }, [native]);

  async function execute(request: OwnedCliParityRequest, confirmation?: string) {
    if (busy || !native) return;
    setError("");
    const invalid = missingInput(request);
    if (invalid) {
      setResult(null);
      setError(invalid);
      return;
    }
    if (confirmation && !window.confirm(confirmation)) return;
    setBusy(true);
    setResult(null);
    try {
      const reply = await runOwnedCliParity(request);
      setResult(reply);
      if (reply.operation === "job-list") setJobs(parseJobList(reply.json));
      if (reply.operation === "profile-list") setProfiles(parseProfiles(reply));
      if (reply.operation.startsWith("profile-add-") || reply.operation.startsWith("profile-remove-")) {
        const updated = await runOwnedCliParity({ operation: "profile-list" });
        setProfiles(parseProfiles(updated));
      }
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "CLI 작업에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  function run(operation: OwnedCliParityOperation, extra: Partial<OwnedCliParityRequest> = {}, confirmation?: string) {
    void execute({ operation, ...extra }, confirmation);
  }
  const profileArgs = { alias: alias.trim() };
  const profileConfirm = (action: string) =>
    "Tauri 전용 CLI의 " + action + " 작업을 진행할까요?\n대상: " + alias +
    "\n기존 WinForms/default:7979는 변경하지 않습니다.";

  return <div className="cli-parity-panel">
    <section className="panel page-panel">
      <div className="panel-heading"><div className="panel-title"><span className="icon-tile">
        <TerminalSquare size={18}/></span><div><h2>Tauri 전용 CLI 명령</h2>
        <p>공식 CLI의 기능을 구분해 네이티브 UI에서 실행합니다.</p></div></div></div>
      <div className="legacy-body">
        <p className="legacy-explanation"><CircleAlert size={17}/>
          모든 명령은 SHA-256 검증된 번들 CLI, <code>tauri-preview-v1</code>, 별도 HOME에서 실행합니다.
          기존 WinForms/7979와 토큰은 유지합니다. 임의 셸 명령은 실행할 수 없습니다.
        </p>
        <div className="cli-parity-tabs" role="tablist" aria-label="CLI 명령 범주">
          {GROUPS.map(item => <button type="button" role="tab" key={item.key}
            aria-selected={group === item.key} className={"cli-parity-tab " + (group === item.key ? "selected" : "")}
            onClick={() => { setGroup(item.key); setError(""); setResult(null); }}>
            <strong>{item.title}</strong><small>{item.subtitle}</small></button>)}
        </div>
        {!native && <p className="form-error" role="alert">CLI 조작은 Windows Tauri 앱에서만 지원합니다.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {group === "profiles" && <div className="cli-parity-section">
          <div className="legacy-pref-row"><div><strong>Python / Docker 프로필</strong>
            <p>별칭을 선택해 조회·테스트·제거하거나 새 별칭으로 등록합니다.</p></div>
            <span className="legacy-value">{profiles.length}개</span></div>
          <div className="legacy-actions"><button type="button" disabled={!native || busy} className="legacy-action available"
            onClick={() => run("profile-list")}><RefreshCcw size={16}/>profile list</button></div>
          {profiles.length > 0 && <ul className="cli-profile-list">
            {profiles.map(p => <li key={p.alias}>
              <button type="button" className="text-action" disabled={busy} onClick={() => setAlias(p.alias)}>{p.alias}</button>
              <small>{p.python ? "Python " : ""}{p.docker ? "Docker" : ""}</small></li>)}
          </ul>}
          <div className="legacy-form-row"><label className="legacy-form-label" htmlFor="cli-profile-alias">
            <strong>프로필 별칭</strong><span>영문·숫자·._- 최대 64자</span></label>
            <div className="legacy-form-control"><input id="cli-profile-alias" className="legacy-field" value={alias}
              onChange={e => setAlias(e.target.value)} placeholder="예: local-py" maxLength={64}/></div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-show", profileArgs)}><Layers size={15}/>profile show</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-test", profileArgs)}><Play size={15}/>profile test</button>
          </div>
          <div className="legacy-form-row"><label className="legacy-form-label" htmlFor="cli-python-path">
            <strong>Python 경로</strong><span>이미 설치된 python.exe 절대 경로</span></label>
            <div className="legacy-form-control"><input id="cli-python-path" className="legacy-field" value={pythonPath}
              onChange={e => setPythonPath(e.target.value)} placeholder="C:\\Python311\\python.exe" maxLength={512}/></div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-add-python", { ...profileArgs, value: pythonPath.trim() }, profileConfirm("profile add --python"))}>
              <Play size={15}/>Python 등록 / 교체</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-remove-python", profileArgs, profileConfirm("profile remove --python"))}>
              <Trash2 size={15}/>Python 제거</button>
          </div>
          <div className="legacy-form-row"><label className="legacy-form-label" htmlFor="cli-compose">
            <strong>Docker Compose 상대 경로</strong><span>상위 경로(..) 없이 .yaml 또는 .yml</span></label>
            <div className="legacy-form-control"><input id="cli-compose" className="legacy-field" value={composeFile}
              onChange={e => setComposeFile(e.target.value)} maxLength={512}/></div></div>
          <div className="cli-parity-fields">
            <label>Compose 프로젝트명<input className="legacy-field" value={projectName}
              onChange={e => setProjectName(e.target.value)} placeholder="dev" maxLength={80}/></label>
            <label>서비스 목록 (쉼표 구분)<input className="legacy-field" value={services}
              onChange={e => setServices(e.target.value)} placeholder="api,db" maxLength={512}/></label>
            <label>제어 서비스 (선택)<input className="legacy-field" value={controlServices}
              onChange={e => setControlServices(e.target.value)} placeholder="api" maxLength={512}/></label>
          </div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-add-docker", { ...profileArgs, composeFile, projectName, services, controlServices },
                profileConfirm("profile add --compose-file"))}><Play size={15}/>Docker 등록 / 교체</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-remove-docker", profileArgs, profileConfirm("profile remove --docker"))}>
              <Trash2 size={15}/>Docker 제거</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("profile-remove-all", profileArgs, profileConfirm("profile remove 전체"))}>
              <Trash2 size={15}/>별칭 전체 제거</button>
          </div>
        </div>}
        {group === "config" && <div className="cli-parity-section">
          <div className="legacy-pref-row"><div><strong>전용 인스턴스 설정</strong>
            <p>config show --instance tauri-preview-v1 · 이 프리뷰의 격리된 설정입니다.</p></div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-show")}><Settings2 size={15}/>config show</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-export")}><Layers size={15}/>config export (비밀정보 제외)</button>
          </div>
          <p className="legacy-footnote">안전한 전용 인스턴스를 위해 host/port/workspace는 고정됩니다.
            다음 키는 CLI가 허용하는 고정 범위에서만 설정할 수 있습니다.</p>
          <div className="cli-parity-fields">
            <label>설정 키<select className="legacy-field" value={configKey} onChange={e => {
              const next = e.target.value; setConfigKey(next);
              setConfigValue(next === "host" ? "127.0.0.1" : next === "port" ? "18797" : "none");
            }}><option value="host">host</option><option value="port">port</option><option value="tunnel">tunnel</option></select></label>
            <label>설정 값<input className="legacy-field" value={configValue} maxLength={80}
              onChange={e => setConfigValue(e.target.value)}/></label>
          </div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-set", { key: configKey, value: configValue },
                "Tauri 전용 인스턴스의 " + configKey + " 설정을 저장할까요?")}><Settings2 size={15}/>config set</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-unset", { key: configKey },
                "Tauri 전용 인스턴스의 " + configKey + " 설정을 해제할까요?")}><Trash2 size={15}/>config unset</button>
          </div>
        </div>}
        {group === "operations" && <div className="cli-parity-section">
          <div className="legacy-pref-row"><div><strong>운영 및 진단</strong>
            <p>재로드는 프로필·프로젝트 목록만 다시 읽습니다. 네트워크/터널 변경은 재시작이 필요합니다.</p></div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("status")}><Activity size={15}/>status</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("health")}><Activity size={15}/>health</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("doctor")}><Activity size={15}/>doctor</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("reload", {}, "실행 중인 Tauri 전용 프로젝트/프로필 목록을 재로드할까요?")}>
              <RefreshCcw size={15}/>reload</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("logs-server")}><TerminalSquare size={15}/>서버 로그</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("logs-tunnel")}><TerminalSquare size={15}/>터널 로그</button>
          </div>
        </div>}
        {group === "advanced" && <div className="cli-parity-section">
          <div className="legacy-pref-row"><div><strong>추가 읽기 전용 CLI 명령</strong>
            <p>프리뷰 격리 HOME의 프로젝트 상세, 비밀정보 이름, 작업·잠금 및 제어 요청 상태만 조회합니다.</p>
          </div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("secret-list")}><Layers size={15}/>secret list (이름만)</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("lock-list")}><Layers size={15}/>lock list</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("job-list")}><Layers size={15}/>job list</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("control-list")}><Layers size={15}/>control list</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("control-auto-status")}><Activity size={15}/>control auto status</button>
          </div>
          {jobs !== null && (jobs.length ? <div className="cli-parity-section">
            <p className="legacy-footnote">조회할 작업을 선택하면 실제 Job ID가 입력됩니다. 프로젝트 ID와는 다릅니다.</p>
            <ul className="cli-profile-list">{jobs.map(job => <li key={job.id}>
              <button type="button" className="text-action" disabled={busy}
                onClick={() => setTarget(job.id)}>{job.id}</button>
              <small>{job.status}{job.projectId ? " · " + job.projectId : ""}</small>
            </li>)}</ul>
          </div> : <p className="legacy-footnote" role="status">
            현재 프리뷰 인스턴스에 저장된 Job이 없습니다. 작업을 생성한 뒤 다시 조회하세요.
          </p>)}
          <div className="legacy-form-row"><label className="legacy-form-label" htmlFor="cli-parity-target">
            <strong>조회 대상 ID</strong><span>repository show는 프로젝트 ID, job 명령은 실제 loop- 작업 ID</span></label>
            <div className="legacy-form-control"><input id="cli-parity-target" className="legacy-field"
              value={target} onChange={e => setTarget(e.target.value)} maxLength={128}
              placeholder="예: my-project 또는 loop-abc123"/></div>
          </div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("repository-show", { target: target.trim() })}>repository show</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("job-status", { target: target.trim() })}>job status</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("job-logs", { target: target.trim() })}>job logs (최대 10건)</button>
          </div>
          <p className="legacy-footnote">상세 결과에 포함될 수 있는 토큰·인증 문자열은 숨깁니다.
            강제 잠금 해제, 작업 취소·재개, 제어 승인·중지, secret 설정·삭제는 실행할 수 없습니다.</p>
        </div>}
        {busy && <p className="legacy-footnote" role="status">번들 CLI 명령 실행 중…</p>}
        {result && <div className="cli-parity-output" role="region" aria-label="CLI 실행 결과">
          <strong>{result.command}</strong><p className="legacy-footnote">{result.note}</p>
          <pre>{result.text ?? JSON.stringify(result.json, null, 2)}</pre>
        </div>}
      </div>
    </section>
    <section className="panel page-panel legacy-spaced">
      <div className="panel-heading"><div className="panel-title"><span className="icon-tile">
        <TerminalSquare size={18}/></span><div><h2>CLI 기능 대응표</h2>
        <p>공식 CLI의 명령과 Tauri UI 연결 범위를 구분했습니다.</p></div></div></div>
      <div className="legacy-body"><div className="cli-parity-matrix">
        <span><strong>start / stop / restart / owner-token</strong><small>관리 화면 · 전용 인스턴스</small></span>
        <span><strong>repository list / add / remove</strong><small>관리 화면 · 등록 프로젝트</small></span>
        <span><strong>profile list / show / add / remove / test</strong><small>이 화면 · 프로필</small></span>
        <span><strong>config show / set / unset / export</strong><small>이 화면 · 고정 인스턴스 안전 값만 수정</small></span>
        <span><strong>status / health / doctor / logs / reload</strong><small>이 화면 · 진단·재로드</small></span>
        <span><strong>config import / import-env, profile import-env</strong><small>CLI 전용 · 파일/환경 변수 반입</small></span>
        <span><strong>secret list / lock list / job list·status·logs / control list·auto status</strong><small>추가 조회 탭 · 읽기 전용</small></span>
        <span><strong>secret set/remove, job cancel/resume, lock release, control approve/reject/kill/auto</strong><small>CLI 전용 · 인증정보 및 권한이 필요한 변경</small></span>
        <span><strong>serve / init / repository use</strong><small>내부 런타임 전용 · Tauri 고정 작업 공간과 분리</small></span>
      </div><p className="legacy-footnote">CLI 전용 항목은 이 UI에서 실행되지 않습니다.
        권한·인증 경계를 유지한 채 후속 단계에서 개별 제공 여부를 결정합니다.</p></div>
    </section>
  </div>;
}
