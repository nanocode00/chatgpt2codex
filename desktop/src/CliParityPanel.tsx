import { useState } from "react";
import { RefreshCcw, TerminalSquare, Settings2, Activity, Layers, Trash2, CircleAlert } from "lucide-react";
import { isNativeApp, runOwnedCliParity, type OwnedCliParityRequest, type OwnedCliParityOperation, type OwnedCliParityResponse } from "./runtime";

type Group = "config" | "operations" | "advanced";

/** Validate on click instead of disabling controls based on unsaved form fields.
 * Native Rust validation remains authoritative (paths, IDs, allowed commands).
 */
function missingInput(request: OwnedCliParityRequest): string | null {
  const operation = request.operation;
  if (operation === "repository-show" && !request.target?.trim()) {
    return "조회할 프로젝트 ID를 입력하세요.";
  }
  return null;
}

const GROUPS: { key: Group; title: string; subtitle: string }[] = [
  { key: "config", title: "설정", subtitle: "config show / set / unset / export" },
  { key: "operations", title: "진단·재로드", subtitle: "status / health / doctor / logs / reload" },
  { key: "advanced", title: "추가 조회", subtitle: "repository / secret / lock / control" }
];

export function CliParityPanel() {
  const native = isNativeApp();
  const [group, setGroup] = useState<Group>("config");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnedCliParityResponse | null>(null);
  const [error, setError] = useState("");
  const [target, setTarget] = useState("");
  const [configKey, setConfigKey] = useState("host");
  const [configValue, setConfigValue] = useState("127.0.0.1");

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
    } catch (err) {
      setError(typeof err === "string" ? err : err instanceof Error ? err.message : "CLI 작업에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  }
  function run(operation: OwnedCliParityOperation, extra: Partial<OwnedCliParityRequest> = {}, confirmation?: string) {
    void execute({ operation, ...extra }, confirmation);
  }
  return <div className="cli-parity-panel">
    <section className="panel page-panel">
      <div className="panel-heading"><div className="panel-title"><span className="icon-tile">
        <TerminalSquare size={18}/></span><div><h2>Tauri 전용 CLI 명령</h2>
        <p>공식 CLI의 기능을 구분해 네이티브 UI에서 실행합니다.</p></div></div></div>
      <div className="legacy-body">
        <p className="legacy-explanation"><CircleAlert size={17}/>
          여기의 명령은 SHA-256 검증된 번들 CLI, <code>tauri-preview-v1</code>, 별도 HOME에서 실행합니다.
          임의 셸 명령은 실행할 수 없습니다. 서버 포트는 설정 화면에서 변경합니다.
        </p>
        <div className="cli-parity-tabs" role="tablist" aria-label="CLI 명령 범주">
          {GROUPS.map(item => <button type="button" role="tab" key={item.key}
            aria-selected={group === item.key} className={"cli-parity-tab " + (group === item.key ? "selected" : "")}
            onClick={() => { setGroup(item.key); setError(""); setResult(null); }}>
            <strong>{item.title}</strong><small>{item.subtitle}</small></button>)}
        </div>
        {!native && <p className="form-error" role="alert">CLI 조작은 Windows Tauri 앱에서만 지원합니다.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {group === "config" && <div className="cli-parity-section">
          <div className="legacy-pref-row"><div><strong>전용 인스턴스 설정</strong>
            <p>config show --instance tauri-preview-v1 · 이 프리뷰의 격리된 설정입니다.</p></div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-show")}><Settings2 size={15}/>config show</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("config-export")}><Layers size={15}/>config export (비밀정보 제외)</button>
          </div>
          <p className="legacy-footnote">서버 포트와 작업 디렉터리는 이 메뉴에서 변경하지 않습니다.
            다음 키는 CLI가 허용하는 범위에서만 설정할 수 있습니다.</p>
          <div className="cli-parity-fields">
            <label>설정 키<select className="legacy-field" value={configKey} onChange={e => {
              const next = e.target.value; setConfigKey(next);
              setConfigValue(next === "host" ? "127.0.0.1" : "none");
            }}><option value="host">host</option><option value="tunnel">tunnel</option></select></label>
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
            <p>프리뷰 격리 HOME의 프로젝트 상세, 비밀정보 이름, 잠금 및 제어 요청 상태를 조회합니다. 작업 관련 명령은 작업 화면으로 이동했습니다.</p>
          </div></div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("secret-list")}><Layers size={15}/>secret list (이름만)</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("lock-list")}><Layers size={15}/>lock list</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("control-list")}><Layers size={15}/>control list</button>
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("control-auto-status")}><Activity size={15}/>control auto status</button>
          </div>
          <div className="legacy-form-row"><label className="legacy-form-label" htmlFor="cli-parity-target">
            <strong>프로젝트 ID</strong><span>repository show 조회를 위한 프로젝트 ID</span></label>
            <div className="legacy-form-control"><input id="cli-parity-target" className="legacy-field"
              value={target} onChange={e => setTarget(e.target.value)} maxLength={128}
              placeholder="예: my-project"/></div>
          </div>
          <div className="legacy-actions">
            <button type="button" disabled={!native || busy} className="legacy-action available"
              onClick={() => run("repository-show", { target: target.trim() })}>repository show</button>
          </div>
          <p className="legacy-footnote">상세 결과에 포함될 수 있는 토큰·인증 문자열은 숨깁니다.
            강제 잠금 해제, 제어 승인·중지, secret 설정·삭제는 실행할 수 없습니다. 작업의 조회·상태 변경은 전용 작업 화면에서 제공합니다.</p>
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
        <span><strong>repository list / show / add / remove</strong><small>프로젝트 화면 · 등록 프로젝트</small></span>
        <span><strong>profile list / show / add / remove / test</strong><small>실행 환경 화면 · Python / Docker</small></span>
        <span><strong>config show / set / unset / export</strong><small>이 화면 · 고정 인스턴스 안전 값만 수정</small></span>
        <span><strong>status / health / doctor / logs / reload</strong><small>이 화면 · 진단·재로드</small></span>
        <span><strong>config import / import-env, profile import-env</strong><small>CLI 전용 · 파일/환경 변수 반입</small></span>
        <span><strong>job list / status / logs / resume / cancel</strong><small>작업 화면 · 저장된 상태 변경, 실제 에이전트 실행/종료 아님</small></span>
        <span><strong>secret list / lock list / control list·auto status</strong><small>추가 조회 탭 · 읽기 전용</small></span>
        <span><strong>secret set/remove, lock release, control approve/reject/kill/auto</strong><small>CLI 전용 · 인증정보 및 권한이 필요한 변경</small></span>
        <span><strong>serve / init / repository use</strong><small>내부 런타임 전용 · Tauri 고정 작업 공간과 분리</small></span>
      </div><p className="legacy-footnote">CLI 전용 항목은 이 UI에서 실행되지 않습니다.
        권한·인증 경계를 유지한 채 후속 단계에서 개별 제공 여부를 결정합니다.</p></div>
    </section>
  </div>;
}
