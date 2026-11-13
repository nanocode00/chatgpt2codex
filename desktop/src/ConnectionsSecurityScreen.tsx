import { useState } from "react";
import {
  Activity, ArrowRight, CheckCircle2, ChevronDown, ClipboardCopy, Cloud, Globe2,
  HardDrive, KeyRound, LockKeyhole, Play, RotateCw,
  ShieldCheck, Square, TerminalSquare, TriangleAlert
} from "lucide-react";
import { publicView, runtimeView, startAction } from "./dashboard-state";
import type { ManagedAction, ManagedResult, PublicTunnelHealth } from "./runtime";
import "./connections.css";

interface ConnectionsSecurityProps {
  native: boolean;
  owned: ManagedResult | null;
  ownedBusy: boolean;
  ownedError: string;
  ownerTokenPending: boolean;
  tokenCopyAvailable: boolean;
  publicPreferred: boolean;
  publicHealth: PublicTunnelHealth | null;
  publicChecking: boolean;
  onManagedAction: (action: ManagedAction) => void;
  onTogglePublic: (enable: boolean) => void;
  onCopyPublic: () => void;
  onCopyToken: () => void;
  onCopyStoredToken: () => Promise<void>;
  onRegisterToken: (candidate: string) => Promise<void>;
  onNotify: (message: string, tone?: "info" | "error") => void;
  onDiagnostics: () => void;
}

/** Inspect only the dedicated Tauri-managed instance, never the legacy/default probe. */
export function ConnectionsSecurityScreen({
  native, owned, ownedBusy, ownedError, ownerTokenPending, tokenCopyAvailable,
  publicPreferred, publicHealth, publicChecking,
  onManagedAction, onTogglePublic, onCopyPublic, onCopyToken,
  onCopyStoredToken, onRegisterToken, onNotify, onDiagnostics
}: ConnectionsSecurityProps) {
  const state = runtimeView(native, owned);
  const running = state === "online";
  const available = native && owned?.available === true;
  const ready = available && owned?.ready === true;
  const runtimeBusy = ownedBusy;
  const exposed = running && owned?.tunnelRunning === true && !!owned.publicConnector;
  const publicState = publicView(owned, publicHealth);
  const canToggle = available && !runtimeBusy && owned?.tunnelCapable === true && !running;
  const nextPublic = !running && publicPreferred;
  const [knownToken, setKnownToken] = useState("");
  const [tokenImportOpen, setTokenImportOpen] = useState(false);
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenError, setTokenError] = useState("");
  const [securityExpanded, setSecurityExpanded] = useState(false);
  const endpoint = "http://127.0.0.1:" + (owned?.port ?? 7979) + "/mcp";
  const publicValue = exposed ? owned?.publicConnector ?? "" : "";
  const publicStatus =
    exposed ? publicChecking || publicState === "unchecked" ? "외부 HTTPS 확인 중" :
      publicState === "online" ? "외부 HTTPS 응답 정상" :
      publicState === "offline" ? "외부 HTTPS 연결 실패" : "외부 상태 확인 불가" :
      nextPublic ? "다음 시작 시 공개 예정" : "외부 공개 꺼짐";
  const localStatus = state === "online" ? "로컬 MCP 실행 중" :
    state === "stopped" ? "로컬 MCP 중지됨" :
    state === "setup" ? "초기 설정 필요" :
    state === "checking" ? "상태 확인 중" : "연결 상태 확인 필요";

  async function copyLocal() {
    try {
      await navigator.clipboard.writeText(endpoint);
      onNotify("Tauri 전용 로컬 MCP 주소를 복사했습니다.");
    } catch {
      onNotify("주소 복사에 실패했습니다. 입력 영역에서 직접 선택해 복사하세요.", "error");
    }
  }

  async function saveKnownToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tokenBusy || runtimeBusy) return;
    setTokenBusy(true); setTokenError("");
    try {
      await onRegisterToken(knownToken);
      setKnownToken("");
      setTokenImportOpen(false);
      onNotify("현재 Tauri Owner Token을 Windows 사용자 전용 암호화 보관소에 등록했습니다.");
    } catch (error) {
      setTokenError(typeof error === "string" ? error.slice(0, 220) :
        error instanceof Error ? error.message.slice(0, 220) : "Owner Token 등록에 실패했습니다.");
    } finally {
      setTokenBusy(false);
    }
  }

  function requestPublicToggle() {
    if (!canToggle) return;
    onTogglePublic(!publicPreferred);
  }

  return <div className="connections-root">
    <header className="connections-heading">
      <div>
        <p className="connections-eyebrow">CONNECTIVITY / SECURITY</p>
        <h1>연결·보안</h1>
        <p>Tauri 전용 MCP를 준비하고, 로컬·외부 연결과 ChatGPT 인증을 확인합니다.</p>
      </div>
    </header>

    <section className="connections-overview" aria-label="연결 현황">
      <div>
        <HardDrive size={18}/><strong>{localStatus}</strong>
        <span>Tauri 전용 · {owned?.instance ?? "tauri-preview-v1"}</span>
      </div>
      <div>
        <Cloud size={18}/><strong>{publicStatus}</strong>
        <span>{exposed ? "Cloudflare Quick Tunnel" : "외부에 노출된 주소 없음"}</span>
      </div>
      <div>
        <ShieldCheck size={18}/><strong>{ownerTokenPending ? "새 토큰 복사 필요" : ready ? "인증 준비됨" : "인증 설정 필요"}</strong>
        <span>OAuth 연결 승인은 별도</span>
      </div>
    </section>

    {ownedError && <div className="connections-error" role="alert">
      <TriangleAlert size={17}/><span>{ownedError}</span>
    </div>}

    <div className="connections-grid">
      <section className="connections-card" aria-labelledby="connections-local-heading">
        <div className="connections-card-heading">
          <div><TerminalSquare size={19}/><h2 id="connections-local-heading">로컬 MCP</h2></div>
          <span className="connections-pill">{localStatus}</span>
        </div>
        <p>이 컴퓨터에서 실행되는 격리된 C2C 인스턴스입니다. 다른 인스턴스의 상태와 구분합니다.</p>
        <label className="connections-field-label" htmlFor="connections-local-url">로컬 MCP URL</label>
        <div className="connections-copy">
          <input id="connections-local-url" readOnly value={endpoint}/>
          <button type="button" aria-label="로컬 MCP URL 복사"
            onClick={() => { void copyLocal(); }}><ClipboardCopy size={16}/></button>
        </div>
        <div className="connections-actions connections-lifecycle-actions" aria-label="MCP 실행 제어">
          {running ? (
            <button type="button" className="connections-button primary"
              disabled={runtimeBusy} onClick={() => onManagedAction("stop")}>
              <Square size={16}/> MCP 중지
            </button>
          ) : (
            <button type="button" className="connections-button primary"
              disabled={!ready || runtimeBusy || (publicPreferred && !owned?.tunnelCapable)}
              onClick={() => onManagedAction(startAction(publicPreferred))}>
              <Play size={16}/> MCP 시작
            </button>
          )}
          <button type="button" className="connections-button secondary"
            disabled={!running || runtimeBusy} onClick={() => onManagedAction("restart")}>
            <RotateCw size={16}/> 재시작
          </button>
        </div>
      </section>

      <section className="connections-card connections-external" aria-labelledby="connections-external-heading">
        <div className="connections-card-heading">
          <div><Globe2 size={19}/><h2 id="connections-external-heading">외부 연결 · Cloudflare</h2></div>
          <span className="connections-pill">{publicStatus}</span>
        </div>
        <div className="connections-toggle-row">
          <div><strong>Quick Tunnel 공개</strong>
            <p>{running ? exposed ? "현재 전용 MCP가 외부에 공개되어 있습니다." :
              "현재 MCP는 로컬에서만 실행 중입니다." :
              publicPreferred ? "다음 MCP 시작 시 공개합니다." : "다음 MCP 시작은 로컬 전용입니다."}</p>
          </div>
          <button type="button" role="switch"
            aria-label="Cloudflare 외부 공개 설정"
            aria-checked={running ? exposed : publicPreferred}
            className={"connections-switch " + ((running ? exposed : publicPreferred) ? "enabled" : "")}
            disabled={!canToggle} onClick={requestPublicToggle}
            title={running ? "실행 중 전환은 OAuth URL 동기화 지원 후 활성화됩니다." : "다음 MCP 시작 시 적용"}
          ><span/></button>
        </div>
        {running && <p className="connections-caution">
          실행 중 외부 공개 전환은 아직 지원하지 않습니다. MCP 실행 상태를 유지한 터널 연결·해제와
          OAuth 주소 동기화가 검증되기 전까지 스위치는 잠겨 있습니다.
        </p>}
        {!owned?.tunnelCapable && <p className="connections-caution">검증된 Cloudflare 런타임이 없어 공개 연결을 사용할 수 없습니다.</p>}
        <label className="connections-field-label" htmlFor="connections-public-url">ChatGPT용 공개 MCP URL</label>
        <div className="connections-copy">
          <input id="connections-public-url" readOnly value={publicValue}
            placeholder={running ? "공개 터널이 실행 중이지 않습니다." : "MCP 시작 후 공개 주소가 표시됩니다."}/>
          <button type="button" aria-label="공개 MCP URL 복사" disabled={!exposed}
            onClick={onCopyPublic}><ClipboardCopy size={16}/></button>
        </div>
        <div className="connections-statusline" role="status">
          <span className={"connections-dot " + (publicState === "online" ? "online" : "")}/>
          {exposed ? publicChecking ? "자동 HTTPS 확인 중" :
            publicState === "online" ? "공개 HTTPS 정상 · OAuth 연결 여부는 별도" :
            publicState === "offline" ? "공개 HTTPS 접속 실패" : "공개 상태 확인 중 또는 검증 불가" :
            "공개 연결 없음 · 상태 확인은 터널 실행 중 자동 수행"}
        </div>
        <p className="connections-subnote">외부 HTTPS는 약 30초마다 자동 확인합니다. Quick Tunnel 주소는 다시 시작하면 달라질 수 있습니다.</p>
      </section>

      <section className="connections-card connections-security" aria-labelledby="connections-token-heading">
        <div className="connections-card-heading">
          <div><LockKeyhole size={19}/><h2 id="connections-token-heading">Owner Token·인증</h2></div>
          <span className="connections-pill">{ready ? "설정됨" : "초기화 필요"}</span>
        </div>
        <p>Owner Token은 인증 승인에 사용하는 민감한 값입니다. CLI에는 해시만 보관되며,
          별도 암호화 보관을 한 토큰만 나중에 복사할 수 있습니다.</p>
        {ownerTokenPending && <div className="connections-token-once">
          <strong>새 Owner Token이 발급됐습니다.</strong>
          <p>원문은 화면에 표시하지 않습니다. ‘Owner Token 복사’로 안전하게 보관하세요.</p>
          {!tokenCopyAvailable && <button type="button" className="connections-button primary"
            disabled={runtimeBusy} onClick={onCopyToken}>
            <ClipboardCopy size={16}/> 일회성 토큰 복사 후 지우기
          </button>}
        </div>}
        <div className="connections-actions connections-token-actions" aria-label="Owner Token 관리">
          <button type="button" className="connections-button primary"
            disabled={!ready || runtimeBusy || tokenBusy || !tokenCopyAvailable}
            onClick={() => { void onCopyStoredToken().then(() =>
              onNotify("Owner Token을 클립보드에 복사했습니다. 민감정보가 남지 않도록 사용 후 클립보드를 정리하세요.")
            ).catch((error: unknown) => onNotify(typeof error === "string" ? error :
              error instanceof Error ? error.message : "Owner Token 복사에 실패했습니다.", "error")); }}>
            <ClipboardCopy size={16}/> Owner Token 복사
          </button>
          <button type="button" className="connections-button secondary"
            disabled={!available || ready || runtimeBusy || tokenBusy}
            onClick={() => onManagedAction("prepare")}>
            <KeyRound size={16}/> 토큰 초기 설정
          </button>
          <button type="button" className="connections-button secondary"
            disabled={!ready || runtimeBusy || running || ownerTokenPending || tokenBusy}
            onClick={() => onManagedAction("rotate-token")}>
            <KeyRound size={16}/> 토큰 재발급
          </button>
        </div>
        {ready && !tokenCopyAvailable && !ownerTokenPending && <div className="connections-token-restore">
          <p>기존 토큰은 해시에서 복구할 수 없습니다. 이전에 보관한 현재 Tauri 토큰이 있다면
            아래에서 한 번 검증·암호화 등록하면 이후부터 복사할 수 있습니다.
            재발급은 기존 OAuth 승인에 영향을 줍니다.</p>
          <button type="button" className="connections-button secondary"
            disabled={runtimeBusy || tokenBusy}
            onClick={() => { setTokenImportOpen(v => !v); setKnownToken(""); setTokenError(""); }}>
            {tokenImportOpen ? "기존 토큰 등록 취소" : "보관 중인 토큰 등록"}
          </button>
          {tokenImportOpen && <form className="connections-token-import" onSubmit={event => { void saveKnownToken(event); }}>
            <label htmlFor="connections-token-candidate">현재 Tauri Owner Token</label>
            <input id="connections-token-candidate" type="password" value={knownToken}
              spellCheck={false} autoComplete="off" maxLength={160}
              disabled={tokenBusy || runtimeBusy}
              onChange={event => setKnownToken(event.target.value)}
              placeholder="보관 중인 현재 Owner Token 입력"/>
            <button type="submit" className="connections-button primary"
              disabled={tokenBusy || runtimeBusy || knownToken.length < 20}>검증 후 암호화 저장</button>
            {tokenError && <p className="connections-inline-error" role="alert">{tokenError}</p>}
          </form>}
        </div>}
        <div className="connections-guidance">
          <button type="button" className="connections-guidance-toggle"
            aria-controls="connections-security-details" aria-expanded={securityExpanded}
            onClick={() => setSecurityExpanded(value => !value)}>
            <span><ShieldCheck size={16}/><strong>Owner Token 보안 안내</strong></span>
            <span className="connections-guidance-action">{securityExpanded ? "접기" : "자세히 보기"}
              <ChevronDown size={16} className={securityExpanded ? "is-expanded" : ""}/></span>
          </button>
          {!securityExpanded && <p className="connections-guidance-summary">
            재발급 시 기존 OAuth 승인이 무효화되며 ChatGPT 재연결이 필요합니다.
          </p>}
          {securityExpanded && <div id="connections-security-details" className="connections-guidance-details">
            <p>토큰 재발급은 <strong>기존 Tauri 전용 OAuth 승인</strong>을 무효화합니다.
              변경 전 MCP를 중지하고, 재발급 후 ChatGPT에서 다시 연결해야 합니다.</p>
            <p>복사 기능은 현재 Windows 사용자 계정에 묶인 DPAPI 암호화 보관소만 사용합니다.</p>
            <p>토큰을 클립보드에 복사하면 다른 앱에서 붙여넣을 수 있으므로 사용 후 클립보드를 정리하세요.</p>
          </div>}
        </div>
        <p className="connections-subnote">‘인증 준비됨’은 토큰 설정 상태만 의미하며 ChatGPT OAuth 승인 완료를 뜻하지 않습니다.</p>
      </section>

      <section className="connections-card connections-guide" aria-labelledby="connections-chatgpt-heading">
        <div className="connections-card-heading">
          <div><CheckCircle2 size={19}/><h2 id="connections-chatgpt-heading">ChatGPT 연결 절차</h2></div>
        </div>
        <ol className="connections-steps">
          <li><strong>전용 MCP 준비</strong><span>Owner Token을 설정하고 안전하게 보관합니다.</span></li>
          <li><strong>외부 공개 설정</strong><span>MCP를 중지한 상태에서 Quick Tunnel 공개를 켜고 시작합니다.</span></li>
          <li><strong>공개 URL 등록</strong><span>위 공개 MCP URL을 복사해 ChatGPT의 연결 설정에 등록합니다.</span></li>
          <li><strong>OAuth 승인 및 확인</strong><span>인증 승인 후 ChatGPT에서 <code>workspace_list_projects</code> 같은 읽기 도구 호출을 확인합니다.</span></li>
        </ol>
        <div className="connections-actions">
          <button type="button" className="connections-button secondary" onClick={onDiagnostics}>
            <Activity size={16}/> 진단·로그 <ArrowRight size={15}/>
          </button>
        </div>
        <p className="connections-subnote">HTTPS Health 확인만으로 OAuth 또는 실제 ChatGPT 도구 호출 성공을 보증하지 않습니다. Named Tunnel은 아직 이 전용 화면에서 설정할 수 없습니다.</p>
      </section>
    </div>
    <div className="connections-boundary">
      <ShieldCheck size={16}/> 이 화면은 현재 앱의 MCP·토큰·Quick Tunnel 연결만 관리합니다.
    </div>
  </div>;
}
