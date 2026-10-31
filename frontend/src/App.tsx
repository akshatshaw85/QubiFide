import { useEffect, useState, type FormEvent } from 'react';
import {
  Atom, Plus, ShieldCheck, ShieldAlert, Copy, LogOut, Send,
  LockKeyhole, Users, Zap, Smile, Activity, ArrowRight,
  CheckCircle2, CircleAlert, Fingerprint, FlaskConical,
  KeyRound, LayoutDashboard, MessageSquareText, Radio, Server,
  Network, Gauge, X,
} from 'lucide-react';

const API = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8000';

type Session = {
  session_id: string;
  participant_token: string;
  active: boolean;
  participant_count: number;
  key_established: boolean;
};

type ExchangeResult = {
  qubits_sent: number;
  bases_matched: number;
  sifted_bits: number;
  test_bits: number;
  errors_in_test: number;
  qber: number | null;
  qber_threshold_percent?: number;
  eve_enabled: boolean;
  simulation_engine?: string;
  key_accepted: boolean;
  key_length_bits: number;
  reason: string;
  chat_unlocked: boolean;
};

type ChatMessage = { id: number; text: string; mine: boolean; time: string };

function messageTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected request error occurred.';
}

function readStoredSession(): Session | null {
  try {
    const raw = window.sessionStorage.getItem('qubifide-session');
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Session>;
    if (typeof value.session_id !== 'string' || typeof value.participant_token !== 'string') return null;
    return value as Session;
  } catch {
    return null;
  }
}

export default function App() {
  const [session, setSession] = useState<Session | null>(() => readStoredSession());
  const [joined, setJoined] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [eve, setEve] = useState(false);
  const [prob, setProb] = useState(1);
  const [qubits, setQubits] = useState(1024);
  const [qberThreshold, setQberThreshold] = useState(11);
  const [result, setResult] = useState<ExchangeResult | null>(null);
  const [status, setStatus] = useState('Create or join a temporary session');
  const [joinId, setJoinId] = useState('');
  const [showJoin, setShowJoin] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [backendStatus, setBackendStatus] = useState<'checking' | 'online' | 'offline'>('checking');
  const [quantumEngine, setQuantumEngine] = useState('Checking quantum engine');

  useEffect(() => {
    try {
      if (session) window.sessionStorage.setItem('qubifide-session', JSON.stringify(session));
      else window.sessionStorage.removeItem('qubifide-session');
    } catch {
      // Session still works in memory if browser storage is unavailable.
    }
  }, [session]);

  async function api(path: string, init?: RequestInit): Promise<any> {
    let response: Response;
    try {
      response = await fetch(API + path, {
        ...init,
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init?.headers || {}),
        },
      });
    } catch {
      throw new Error(`Cannot reach the QubiFide backend at ${API}. Start the Python backend and refresh.`);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `Request failed (${response.status})`;
      throw new Error(detail);
    }
    return data;
  }

  useEffect(() => {
    let alive = true;
    const checkHealth = async () => {
      try {
        const response = await fetch(`${API}/api/health`);
        const data = await response.json();
        if (!alive) return;
        setBackendStatus(response.ok ? 'online' : 'offline');
        setQuantumEngine(String(data.quantum_engine || 'Unknown quantum engine'));
      } catch {
        if (alive) {
          setBackendStatus('offline');
          setQuantumEngine('Backend unavailable');
        }
      }
    };
    void checkHealth();
    const timer = window.setInterval(() => void checkHealth(), 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  function resetChat() {
    setMessages([]);
    setResult(null);
    setDraft('');
    setError('');
  }

  async function create() {
    try {
      setError('');
      const created = (await api('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ participant_name: 'You' }),
      })) as Session;
      setSession(created);
      setJoined(false);
      resetChat();
      setStatus('Waiting for the other participant');
      setProgress('Share the session ID, then join from a second browser window.');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function join() {
    const id = joinId.trim().toUpperCase();
    if (!id) {
      setError('Enter the session ID from the first browser window.');
      return;
    }
    try {
      setError('');
      const joinedSession = (await api(`/api/sessions/${encodeURIComponent(id)}/join`, {
        method: 'POST',
        body: JSON.stringify({ participant_name: 'Other participant' }),
      })) as Session;
      setSession(joinedSession);
      setJoined(joinedSession.participant_count >= 2);
      resetChat();
      setStatus('Session active · 2 participants');
      setProgress('Both participants are connected. Run the BB84 key exchange.');
      setShowJoin(false);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function exchange(attackEnabled: boolean) {
    if (!session) return;
    if (!joined) {
      setError('A second participant must join before key exchange can start. Open this session in another browser window and join using its ID.');
      return;
    }
    setBusy(true);
    setError('');
    setMessages([]);
    setResult(null);
    setSession((previous) => previous ? { ...previous, key_established: false } : previous);
    setProgress('Running batched Qiskit Aer circuits and measuring QBER… Previous messages are cleared when a new key is established.');
    try {
      const exchangeResult = (await api(`/api/sessions/${encodeURIComponent(session.session_id)}/key-exchange`, {
        method: 'POST',
        body: JSON.stringify({
          participant_token: session.participant_token,
          qubits,
          eve_enabled: attackEnabled,
          eve_probability: prob,
          qber_threshold: qberThreshold / 100,
          test_fraction: 0.20,
        }),
      })) as ExchangeResult;
      setResult(exchangeResult);
      setSession((previous) => previous
        ? { ...previous, key_established: exchangeResult.chat_unlocked }
        : previous);
      setStatus(exchangeResult.chat_unlocked ? 'Secure session established' : 'Key rejected · chat locked');
      setProgress(exchangeResult.reason);
    } catch (caught) {
      setError(errorMessage(caught));
      setProgress('Key exchange failed. Check the backend terminal for details.');
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!session || !result?.chat_unlocked || !text) return;
    try {
      setError('');
      const response = await api(`/api/sessions/${encodeURIComponent(session.session_id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ participant_token: session.participant_token, text }),
      });
      const sentMessage: ChatMessage = {
        id: Number(response.id),
        text: response.message ?? text,
        mine: true,
        time: messageTime(response.created_at),
      };
      setMessages((previous) => previous.some((message) => message.id === sentMessage.id)
        ? previous
        : [...previous, sentMessage]);
      setDraft('');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function end() {
    if (!session) return;
    try {
      await api(`/api/sessions/${encodeURIComponent(session.session_id)}`, { method: 'DELETE', headers: { 'X-Participant-Token': session.participant_token } });
      setSession(null);
      setJoined(false);
      resetChat();
      setStatus('Session ended');
      setProgress('Create a new temporary session to continue.');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function copy() {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.session_id);
      setProgress('Session ID copied to clipboard.');
    } catch {
      setProgress(`Share this session ID: ${session.session_id}`);
    }
  }

  // Keep both browser windows synchronized: poll participant count, the latest
  // key-exchange summary, and encrypted-at-rest messages every 1.5 seconds.
  // This intentionally uses REST polling, so a WebSocket is not required.
  useEffect(() => {
    if (!session) return;
    let alive = true;

    const poll = async () => {
      try {
        const info = await api(`/api/sessions/${encodeURIComponent(session.session_id)}`, { headers: { 'X-Participant-Token': session.participant_token } });
        if (!alive) return;
        if (!info.active) {
          setStatus('Session ended');
          setProgress('This temporary session has been closed. Create a new session to continue.');
          setSession(null);
          setJoined(false);
          resetChat();
          return;
        }
        const hasTwoParticipants = Number(info.participant_count) >= 2;
        setJoined(hasTwoParticipants);
        setSession((previous) => previous && previous.session_id === session.session_id
          ? { ...previous, participant_count: Number(info.participant_count), key_established: Boolean(info.key_established) }
          : previous);

        if (!hasTwoParticipants) {
          setStatus('Waiting for the other participant');
          return;
        }

        let latestResult: ExchangeResult | null = null;
        try {
          latestResult = (await api(`/api/sessions/${encodeURIComponent(session.session_id)}/key-exchange`, { headers: { 'X-Participant-Token': session.participant_token } })) as ExchangeResult;
        } catch {
          // 404 is expected until a participant has run the first exchange.
        }
        if (!alive) return;
        if (latestResult) {
          setResult(latestResult);
          setStatus(latestResult.chat_unlocked ? 'Secure session established' : 'Key rejected · chat locked');
          if (latestResult.reason) setProgress(latestResult.reason);
        } else {
          setResult(null);
          setMessages([]);
          setStatus('Session active · 2 participants');
        }

        const unlocked = Boolean(latestResult?.chat_unlocked || info.key_established);
        if (unlocked) {
          const response = await api(
            `/api/sessions/${encodeURIComponent(session.session_id)}/messages`,
            { headers: { 'X-Participant-Token': session.participant_token } },
          );
          if (!alive) return;
          const loaded: ChatMessage[] = (response.messages || []).map((message: any) => ({
            id: Number(message.id),
            text: String(message.message),
            mine: Boolean(message.mine),
            time: messageTime(message.created_at),
          }));
          setMessages(loaded);
        }
      } catch (caught) {
        if (alive) {
          const message = errorMessage(caught);
          if (message.includes('Session not found or inactive')) {
            setStatus('Session ended');
            setProgress('This temporary session has ended. Create a new one to continue.');
            setSession(null);
            setJoined(false);
            resetChat();
          } else {
            setError(message);
          }
        }
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [session?.session_id, session?.participant_token]);

  return (
    <div className="qf-app">
      <aside className="qf-sidebar">
        <div className="qf-brand">
          <div className="qf-logo"><Atom size={23} /></div>
          <div className="qf-brand-copy">
            <strong>QubiFide</strong>
            <span>QUANTUM SECURITY</span>
          </div>
        </div>

        <div className="qf-sidebar-label">WORKSPACE</div>
        <button className="qf-sidebar-action qf-primary" onClick={() => void create()} disabled={Boolean(session)}>
          <Plus size={17} /> Create session
        </button>
        <button className="qf-sidebar-action qf-secondary" onClick={() => setShowJoin((value) => !value)}>
          <Users size={16} /> Join with session ID
        </button>
        {showJoin && (
          <form className="qf-join-form" onSubmit={(event) => { event.preventDefault(); void join(); }}>
            <label htmlFor="qf-session-id">Session ID</label>
            <input id="qf-session-id" value={joinId} onChange={(event) => setJoinId(event.target.value)} placeholder="Enter session ID" autoComplete="off" />
            <button type="submit" className="qf-primary qf-join-submit">Join session <ArrowRight size={15} /></button>
          </form>
        )}

        <div className="qf-sidebar-label qf-nav-label">PLATFORM</div>
        <div className="qf-nav-item qf-nav-active"><LayoutDashboard size={17} /><span>Research workspace</span><span className="qf-nav-dot" /></div>
        <div className="qf-nav-item"><FlaskConical size={17} /><span>BB84 experiments</span></div>
        <div className="qf-nav-item"><Activity size={17} /><span>QBER analysis</span></div>
        <div className="qf-nav-item"><KeyRound size={17} /><span>Key management</span></div>

        <div className="qf-sidebar-bottom">
          <div className="qf-mini-card">
            <div className="qf-mini-icon"><Fingerprint size={18} /></div>
            <strong>Security by design</strong>
            <p>BB84 simulation, error-rate analysis, and authenticated encryption in one research workspace.</p>
          </div>
          <div className="qf-api-status">
            <span className={`qf-status-dot ${backendStatus === 'online' ? 'is-online' : backendStatus === 'offline' ? 'is-offline' : 'is-checking'}`} />
            <div><strong>{backendStatus === 'checking' ? 'Checking backend' : backendStatus === 'offline' ? 'Backend offline' : 'Backend connected'}</strong><small>{backendStatus === 'online' ? quantumEngine : backendStatus === 'offline' ? 'Start FastAPI to continue' : 'Checking API health'}</small></div>
          </div>
        </div>
      </aside>

      <div className="qf-main-column">
        <header className="qf-topbar">
          <div className="qf-topbar-title">
            <div className="qf-eyebrow">QUANTUM KEY DISTRIBUTION · RESEARCH CONSOLE</div>
            <h1>{session ? 'Session workspace' : 'Secure communication, explored.'}</h1>
            <p>{session ? (joined ? 'Two participants are connected to this temporary session.' : 'Waiting for a second participant to join the session.') : 'Explore BB84 key exchange, eavesdropping detection, and authenticated messaging.'}</p>
          </div>
          <div className="qf-topbar-actions">
            <div className={`qf-connection-pill ${backendStatus === 'online' ? 'connected' : 'disconnected'}`}><span />{backendStatus === 'online' ? 'API online' : backendStatus === 'checking' ? 'Checking API' : 'API offline'}</div>
            {session && <button className="qf-icon-button" onClick={() => void copy()} title="Copy session ID" aria-label="Copy session ID"><Copy size={16} /></button>}
            {session && <button className="qf-end-button" onClick={() => void end()}><LogOut size={15} /> End session</button>}
          </div>
        </header>

        {error && <div className="qf-global-error" role="alert"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}

        <div className="qf-workspace-grid">
          <main className="qf-workspace-main">
            {!session ? (
              <>
                <section className="qf-welcome-card">
                  <div className="qf-welcome-art"><div className="qf-orbit qf-orbit-one" /><div className="qf-orbit qf-orbit-two" /><div className="qf-atom-icon"><Atom size={36} /></div><span className="qf-art-node qf-node-a" /><span className="qf-art-node qf-node-b" /><span className="qf-art-node qf-node-c" /></div>
                  <div className="qf-eyebrow">A QUANTUM-INSPIRED SECURITY LAB</div>
                  <h2>Understand the exchange.<br /><span>Measure the risk.</span></h2>
                  <p>QubiFide brings BB84 quantum key distribution, QBER evaluation, simulated eavesdropping, and authenticated encryption into a single interactive research environment.</p>
                  <div className="qf-welcome-actions">
                    <button className="qf-primary" onClick={() => void create()}><Plus size={17} /> Create temporary session</button>
                    <button className="qf-secondary qf-light-secondary" onClick={() => setShowJoin(true)}><Users size={16} /> Join existing session</button>
                  </div>
                  <div className="qf-demo-note"><ShieldCheck size={16} /><span>Educational software simulation. No physical quantum channel is used.</span></div>
                </section>
                <section className="qf-feature-grid">
                  <article className="qf-feature-card"><div className="qf-feature-icon feature-blue"><Network size={19} /></div><div><strong>BB84 protocol</strong><p>Prepare states, compare bases, and form sifted key material.</p></div></article>
                  <article className="qf-feature-card"><div className="qf-feature-icon feature-teal"><Activity size={19} /></div><div><strong>QBER analysis</strong><p>Estimate sampled mismatches and evaluate the configured threshold.</p></div></article>
                  <article className="qf-feature-card"><div className="qf-feature-icon feature-violet"><LockKeyhole size={19} /></div><div><strong>Authenticated messaging</strong><p>Demonstrate HKDF key derivation and AES-GCM message protection.</p></div></article>
                </section>
              </>
            ) : (
              <>
                <section className="qf-panel qf-session-overview">
                  <div className="qf-panel-heading">
                    <div><div className="qf-eyebrow">ACTIVE SESSION</div><h2>Communication workspace</h2><p>Temporary participant session · changes are shared with the other browser.</p></div>
                    <span className={`qf-state-tag ${result?.chat_unlocked ? 'state-secure' : 'state-pending'}`}><span />{result?.chat_unlocked ? 'Exchange accepted' : result ? 'Exchange rejected' : 'Key exchange pending'}</span>
                  </div>
                  <div className="qf-session-details">
                    <div><span>SESSION IDENTIFIER</span><strong>{session.session_id}</strong></div>
                    <div><span>PARTICIPANTS</span><strong>{joined ? '02 connected' : 'Waiting for participant'}</strong></div>
                    <div><span>MESSAGE STATUS</span><strong>{result?.chat_unlocked ? 'Enabled' : 'Locked pending verification'}</strong></div>
                  </div>
                </section>

                <section className="qf-metric-grid" aria-label="Key exchange metrics">
                  <article className="qf-metric-card"><div className="qf-metric-top"><span>QUBITS SENT</span><div className="metric-icon metric-blue"><Radio size={17} /></div></div><strong>{result?.qubits_sent ?? '—'}</strong><small>{result ? 'Simulated circuit count' : 'Waiting for experiment'}</small></article>
                  <article className="qf-metric-card"><div className="qf-metric-top"><span>QBER</span><div className="metric-icon metric-teal"><Activity size={17} /></div></div><strong>{result?.qber == null ? '—' : `${(result.qber * 100).toFixed(2)}%`}</strong><small>{result?.qber == null ? 'No sample measured yet' : `Threshold ${result.qber_threshold_percent?.toFixed(1) ?? qberThreshold}%`}</small></article>
                  <article className="qf-metric-card"><div className="qf-metric-top"><span>SIFTED BITS</span><div className="metric-icon metric-violet"><Network size={17} /></div></div><strong>{result?.sifted_bits ?? '—'}</strong><small>{result ? `${result.bases_matched} matching bases` : 'Awaiting basis reconciliation'}</small></article>
                  <article className="qf-metric-card"><div className="qf-metric-top"><span>APPLICATION KEY</span><div className="metric-icon metric-amber"><KeyRound size={17} /></div></div><strong>{result?.chat_unlocked ? `${result.key_length_bits} bit` : '—'}</strong><small>{result?.chat_unlocked ? 'Derived for this demo session' : 'Available after acceptance'}</small></article>
                </section>

                <section className="qf-panel qf-protocol-panel">
                  <div className="qf-panel-heading compact-heading"><div><div className="qf-eyebrow">PROTOCOL PIPELINE</div><h3>Exchange lifecycle</h3></div><span className="qf-engine-tag"><Server size={14} /> {quantumEngine}</span></div>
                  <div className="qf-pipeline">
                    <div className={`qf-pipeline-step ${result ? 'step-complete' : 'step-current'}`}><span className="qf-step-number">01</span><div><strong>State preparation</strong><small>Alice encodes random bits</small></div><CheckCircle2 size={16} /></div>
                    <div className="qf-pipeline-connector" />
                    <div className={`qf-pipeline-step ${result ? 'step-complete' : ''}`}><span className="qf-step-number">02</span><div><strong>Measurement & sifting</strong><small>Compare the preparation bases</small></div><CheckCircle2 size={16} /></div>
                    <div className="qf-pipeline-connector" />
                    <div className={`qf-pipeline-step ${result ? 'step-complete' : ''}`}><span className="qf-step-number">03</span><div><strong>QBER verification</strong><small>Evaluate sampled mismatches</small></div><CheckCircle2 size={16} /></div>
                    <div className="qf-pipeline-connector" />
                    <div className={`qf-pipeline-step ${result?.chat_unlocked ? 'step-complete' : ''}`}><span className="qf-step-number">04</span><div><strong>Key derivation</strong><small>{result?.chat_unlocked ? 'Application key available' : 'Requires an accepted exchange'}</small></div><LockKeyhole size={16} /></div>
                  </div>
                </section>

                <section className="qf-panel qf-messages-panel">
                  <div className="qf-panel-heading qf-message-heading"><div className="qf-message-title-icon"><MessageSquareText size={19} /></div><div><h3>Authenticated message exchange</h3><p>{result?.chat_unlocked ? 'The exchange passed the configured checks. Messages use AES-GCM in this prototype.' : 'The communication channel stays locked until the key exchange is accepted.'}</p></div><span className={`qf-state-tag ${result?.chat_unlocked ? 'state-secure' : 'state-pending'}`}>{result?.chat_unlocked ? 'Unlocked' : 'Locked'}</span></div>
                  <div className="qf-message-transcript" aria-label="Conversation messages">
                    {!messages.length && <div className="qf-empty-transcript"><div className="qf-empty-icon"><LockKeyhole size={20} /></div><strong>{result?.chat_unlocked ? 'No messages in this session yet' : 'Communication is awaiting verification'}</strong><p>{result?.chat_unlocked ? 'Send a message to test encrypted transport and authentication.' : 'Connect both participants, then run the BB84 exchange. Messaging will unlock if the exchange is accepted.'}</p></div>}
                    {messages.map((message) => (
                      <article key={message.id} className={`qf-message-record ${message.mine ? 'record-mine' : 'record-theirs'}`}>
                        <div className={`qf-message-avatar ${message.mine ? 'avatar-mine' : 'avatar-theirs'}`}>{message.mine ? 'A' : 'B'}</div>
                        <div className="qf-message-record-body"><div className="qf-message-meta"><strong>{message.mine ? 'Participant A · You' : 'Participant B'}</strong><time>{message.time}</time></div><p>{message.text}</p></div>
                        <div className="qf-message-integrity" title="Message record"><LockKeyhole size={14} /></div>
                      </article>
                    ))}
                  </div>
                  <form className="qf-composer" onSubmit={(event) => void send(event)}>
                    <div className="qf-composer-label"><span>COMPOSE MESSAGE</span><span>{result?.chat_unlocked ? 'AES-GCM enabled' : 'Exchange required'}</span></div>
                    <div className="qf-composer-row"><button className="qf-composer-tool" type="button" title="Insert smile" aria-label="Insert smile" onClick={() => setDraft((value) => `${value}🙂`)} disabled={!result?.chat_unlocked}><Smile size={18} /></button><input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={!result?.chat_unlocked} placeholder={result?.chat_unlocked ? 'Write a message for this session…' : 'Messaging is locked until the key exchange is accepted'} aria-label="Message text" /><button className="qf-send-button" disabled={!result?.chat_unlocked || !draft.trim()}><Send size={16} /> Send</button></div>
                  </form>
                </section>
              </>
            )}
          </main>

          <aside className="qf-security-rail">
            <section className="qf-rail-heading"><div className="qf-rail-heading-icon"><ShieldCheck size={19} /></div><div><span className="qf-eyebrow">LIVE MONITORING</span><h2>Security controls</h2></div><span className={`qf-rail-lock ${result?.chat_unlocked ? 'is-secure' : ''}`}><LockKeyhole size={15} /></span></section>

            <section className="qf-rail-card qf-rail-session">
              <div className="qf-rail-card-title"><span>Session details</span><span className={`qf-mini-badge ${session ? 'badge-active' : 'badge-idle'}`}>{session ? 'ACTIVE' : 'IDLE'}</span></div>
              <div className="qf-rail-label">SESSION ID</div>
              <div className="qf-session-id"><strong>{session?.session_id || 'Not created'}</strong><button onClick={() => void copy()} disabled={!session} title="Copy session ID" aria-label="Copy session ID"><Copy size={14} /></button></div>
              <div className="qf-rail-divider" />
              <div className="qf-rail-stat-row"><span>Participants</span><strong>{session ? `${joined ? 2 : 1} / 2` : '0 / 2'}</strong></div>
              <div className="qf-rail-stat-row"><span>Key exchange</span><strong className={result?.chat_unlocked ? 'text-success' : 'text-pending'}>{result?.chat_unlocked ? 'Accepted' : result ? 'Rejected' : 'Not run'}</strong></div>
              <div className="qf-rail-stat-row"><span>Attack model</span><strong>{result?.eve_enabled ? 'Eve enabled' : 'Intercept-resend'}</strong></div>
            </section>

            <section className="qf-rail-card">
              <div className="qf-rail-card-title"><span><FlaskConical size={16} /> BB84 experiment</span><span className="qf-tiny-tag">CONFIG</span></div>
              <p className="qf-rail-description">Configure the simulation and run the protocol for both connected participants.</p>
              <label className="qf-control-label" htmlFor="qf-qubits">Number of qubits <strong>{qubits}</strong></label>
              <input id="qf-qubits" className="qf-number-input" type="number" min={16} max={4096} step={1} value={qubits} onChange={(event) => setQubits(Math.max(16, Math.min(4096, Number(event.target.value) || 16)))} disabled={busy} />
              <label className="qf-control-label qf-range-label" htmlFor="qf-threshold">QBER acceptance threshold <strong>{qberThreshold}%</strong></label>
              <input id="qf-threshold" className="qf-range-input" type="range" min={1} max={25} value={qberThreshold} onChange={(event) => setQberThreshold(Number(event.target.value))} disabled={busy} />
              <button className="qf-primary qf-run-button" disabled={!session || !joined || busy} onClick={() => void exchange(eve)}><Zap size={16} />{busy ? 'Running simulation…' : 'Run BB84 exchange'}</button>
              {!joined && <div className="qf-inline-hint"><Users size={14} /> A second participant must join first.</div>}
            </section>

            <section className="qf-rail-card qf-eve-card">
              <div className="qf-rail-card-title"><span><ShieldAlert size={16} /> Eavesdropping experiment</span><span className="qf-tiny-tag qf-tag-eve">OPTIONAL</span></div>
              <p className="qf-rail-description">Simulate Eve intercepting and resending qubits to evaluate its effect on QBER.</p>
              <label className="qf-switch-row"><span><strong>Enable Eve</strong><small>For the next exchange</small></span><input type="checkbox" checked={eve} onChange={(event) => setEve(event.target.checked)} disabled={busy} /><i /></label>
              {eve && <div className="qf-eve-probability"><label htmlFor="qf-prob">Attack probability <strong>{Math.round(prob * 100)}%</strong></label><input id="qf-prob" type="range" min="0" max="100" value={prob * 100} onChange={(event) => setProb(Number(event.target.value) / 100)} disabled={busy} /></div>}
              <button className="qf-eve-button" disabled={!session || !joined || busy} onClick={() => void exchange(true)}><ShieldAlert size={15} />{busy ? 'Running attack…' : 'Run Eve experiment'}</button>
            </section>

            {progress && <div className="qf-progress-card"><div className="qf-progress-icon">{busy ? <Activity size={16} /> : result?.chat_unlocked ? <CheckCircle2 size={16} /> : <Gauge size={16} />}</div><div><strong>{busy ? 'Experiment in progress' : result ? (result.chat_unlocked ? 'Exchange accepted' : 'Exchange decision') : 'Session status'}</strong><p>{progress}</p></div></div>}
            {result && <section className={`qf-result-card ${result.chat_unlocked ? 'result-accepted' : 'result-rejected'}`}><div className="qf-result-heading">{result.chat_unlocked ? <CheckCircle2 size={18} /> : <CircleAlert size={18} />}<strong>{result.chat_unlocked ? 'Key exchange accepted' : 'Key exchange rejected'}</strong></div><p>{result.reason}</p><div className="qf-result-details"><span>Test errors</span><strong>{result.errors_in_test} / {result.test_bits}</strong><span>Matching bases</span><strong>{result.bases_matched}</strong><span>QBER threshold</span><strong>{result.qber_threshold_percent?.toFixed(1) ?? qberThreshold}%</strong></div>{result.simulation_engine && <small className="qf-engine-note">Simulation engine: {result.simulation_engine}</small>}</section>}

            <section className="qf-rail-card qf-participant-card"><div className="qf-rail-card-title"><span><Users size={16} /> Participants</span></div><div className="qf-participant-row"><div className="qf-participant-avatar">A</div><div><strong>Participant A</strong><small>Current browser</small></div><span className="qf-status-dot is-online" /></div><div className="qf-participant-row"><div className="qf-participant-avatar participant-b">B</div><div><strong>Participant B</strong><small>{joined ? 'Connected' : 'Waiting to join'}</small></div><span className={`qf-status-dot ${joined ? 'is-online' : 'is-offline'}`} /></div></section>
            <div className="qf-security-footnote"><LockKeyhole size={14} /><span>Educational prototype. Quantum circuits are simulated locally; the backend handles demo key material. Not production QKD or end-to-end security.</span></div>
          </aside>
        </div>
      </div>
    </div>
  );
}
