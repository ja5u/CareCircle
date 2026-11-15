import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import gsap from "gsap";
import {
  Activity,
  ArrowDownRight,
  ArrowRight,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock3,
  Heart,
  HeartHandshake,
  History,
  Home,
  LogOut,
  Menu,
  Mic,
  Pill,
  Plus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  UsersRound,
  X,
} from "lucide-react";

const API_ROOT = "/api";
const NAV_ITEMS = [
  { id: "Today", label: "Today", icon: Home },
  { id: "Medications", label: "Medications", icon: Pill },
  { id: "Appointments", label: "Appointments", icon: CalendarDays },
  { id: "Care Circle", label: "Care circle", icon: UsersRound },
  { id: "History", label: "Care history", icon: History },
];

function messageFromError(error) {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function formatDate(value, zone, options = {}) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: zone,
    day: "numeric",
    month: "short",
    ...options,
  }).format(new Date(value));
}

function formatTime(value, zone) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function dateKey(value, zone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatDateTimeLocal(value, zone) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function zonedDateTimeToIso(value, zone) {
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const [hour, minute] = value.slice(11, 16).split(":").map(Number);
  const desiredUtc = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = desiredUtc;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const part = (type) => Number(parts.find((item) => item.type === type)?.value);
    const representedUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    const difference = representedUtc - desiredUtc;
    timestamp -= difference;
    if (!difference) break;
  }
  return new Date(timestamp).toISOString();
}

function parseTimes(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.join(", ") : "";
  } catch {
    return "";
  }
}

function currentDate(zone) {
  return dateKey(new Date(), zone);
}

function roleName(role) {
  if (role === "owner") return "Profile owner";
  if (role === "editor") return "Caregiver";
  return "Family viewer";
}

function doseStatus(dose, now, graceMinutes) {
  if (dose.status === "taken") return "Taken";
  if (dose.status === "skipped") return "Skipped";
  const due = new Date(dose.due_at);
  if (due.getTime() + graceMinutes * 60_000 < now.getTime()) return "Needs attention";
  return due <= now ? "Due now" : "Upcoming";
}

function createWav(audioBuffer) {
  const samples = audioBuffer.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeText = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };
  writeText(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function Brand({ compact = false }) {
  return (
    <div className={`brand ${compact ? "brand-compact" : ""}`}>
      <span className="brand-mark"><Heart size={20} fill="currentColor" /></span>
      <span>
        <strong>CareCircle</strong>
        {!compact && <small>Everyday care, together</small>}
      </span>
    </div>
  );
}

function Notice({ notice, onClose }) {
  if (!notice) return null;
  return (
    <div className={`notice notice-${notice.tone}`} role={notice.tone === "error" ? "alert" : "status"}>
      {notice.tone === "error" ? <CircleHelp size={18} /> : <Check size={18} />}
      <span>{notice.text}</span>
      <button className="icon-button notice-close" aria-label="Dismiss message" onClick={onClose}><X size={17} /></button>
    </div>
  );
}

function AuthScreen({ request, onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({
    name: "",
    email: "",
    passcode: "",
    repeat: "",
    timezone: "Asia/Kolkata",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (mode === "register" && form.passcode !== form.repeat) {
      setError("The passcodes do not match.");
      return;
    }
    setBusy(true);
    try {
      const body = mode === "login"
        ? { email: form.email, passcode: form.passcode }
        : { name: form.name, email: form.email, passcode: form.passcode, timezone: form.timezone };
      const result = await request(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body,
      });
      onAuthenticated(result.token);
    } catch (requestError) {
      setError(messageFromError(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-decoration auth-decoration-one" />
      <div className="auth-decoration auth-decoration-two" />
      <section className="auth-layout">
        <div className="auth-story">
          <Brand />
          <div className="auth-story-copy">
            <span className="eyebrow"><HeartHandshake size={15} /> Care works better together</span>
            <h1>A calmer way to keep up with everyday care.</h1>
            <p>One shared plan for medicines, appointments, and the people who care about you.</p>
            <div className="auth-points">
              <span><CheckCheck size={17} /> Clear daily medication plan</span>
              <span><ShieldCheck size={17} /> You choose who can help</span>
              <span><Bell size={17} /> Gentle reminders, on your terms</span>
            </div>
          </div>
          <p className="auth-footnote">CareCircle supports your care routine. It does not replace medical advice.</p>
        </div>

        <div className="auth-card">
          <div className="auth-card-heading">
            <span className="eyebrow">{mode === "login" ? "Welcome back" : "Get started"}</span>
            <h2>{mode === "login" ? "Sign in to your care space" : "Create your account"}</h2>
            <p>{mode === "login" ? "Your care circle is ready when you are." : "You can invite trusted people after setup."}</p>
          </div>
          <div className="auth-toggle" role="tablist" aria-label="Account options">
            <button className={mode === "login" ? "active" : ""} role="tab" aria-selected={mode === "login"} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
            <button className={mode === "register" ? "active" : ""} role="tab" aria-selected={mode === "register"} onClick={() => { setMode("register"); setError(""); }}>Create account</button>
          </div>
          <form onSubmit={submit} className="form-stack">
            {mode === "register" && (
              <label>
                Your name
                <input autoComplete="name" required maxLength={80} value={form.name} onChange={update("name")} placeholder="e.g. Meera" />
              </label>
            )}
            <label>
              Email address
              <input autoComplete="email" type="email" required value={form.email} onChange={update("email")} placeholder="you@example.com" />
            </label>
            <label>
              Personal passcode
              <input autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" minLength={8} maxLength={64} required value={form.passcode} onChange={update("passcode")} placeholder="At least 8 characters" />
            </label>
            {mode === "register" && (
              <>
                <label>
                  Repeat passcode
                  <input autoComplete="new-password" type="password" minLength={8} maxLength={64} required value={form.repeat} onChange={update("repeat")} placeholder="Enter it again" />
                </label>
                <label>
                  Time zone
                  <select value={form.timezone} onChange={update("timezone")}>
                    {["Asia/Kolkata", "UTC", "Europe/London", "America/New_York", "Australia/Sydney"].map((zone) => <option key={zone}>{zone}</option>)}
                  </select>
                </label>
              </>
            )}
            {error && <p className="inline-error" role="alert">{error}</p>}
            <button className="button button-primary button-wide" type="submit" disabled={busy}>
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              {!busy && <ArrowRight size={17} />}
            </button>
          </form>
          <p className="auth-note">A caretaker or family member? Create your own account, then join with an invitation code.</p>
        </div>
      </section>
    </main>
  );
}

function Sidebar({ me, profileId, setProfileId, page, setPage, onLogout, request, onChanged, mobileOpen, closeMobile }) {
  const [inviteCode, setInviteCode] = useState("");
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [joinOpen, setJoinOpen] = useState(false);

  const joinCircle = async (event) => {
    event.preventDefault();
    setJoining(true);
    setJoinError("");
    try {
      const result = await request("/invitations/join", { method: "POST", body: { code: inviteCode } });
      setInviteCode("");
      setJoinOpen(false);
      onChanged(result.profile_id);
    } catch (error) {
      setJoinError(messageFromError(error));
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      {mobileOpen && <button className="mobile-backdrop" aria-label="Close menu" onClick={closeMobile} />}
      <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand"><Brand /></div>
        <label className="profile-picker">
          <span>CARE PROFILE</span>
          <select value={profileId} onChange={(event) => setProfileId(event.target.value)}>
            {me.profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <ChevronDown size={16} />
        </label>
        <nav className="main-nav" aria-label="Main navigation">
          <span className="nav-section-label">CARE SPACE</span>
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-link ${page === id ? "nav-link-active" : ""}`}
              onClick={() => { setPage(id); closeMobile(); }}
              aria-current={page === id ? "page" : undefined}
            >
              <Icon size={19} strokeWidth={1.8} />
              <span>{label}</span>
              {id === "Today" && page === id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-lower">
          <div className={`join-card ${joinOpen ? "join-card-open" : ""}`}>
            <button className="join-card-trigger" onClick={() => { setJoinOpen(!joinOpen); setJoinError(""); }}>
              <span className="join-card-icon"><UsersRound size={17} /></span>
              <span><strong>Join a care circle</strong><small>Use an invitation code</small></span>
              <Plus size={16} />
            </button>
            {joinOpen && (
              <form className="join-form" onSubmit={joinCircle}>
                <label htmlFor="join-code">Invitation code</label>
                <input id="join-code" required value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} />
                {joinError && <p className="inline-error">{joinError}</p>}
                <button className="button button-primary button-small" disabled={joining}>{joining ? "Joining…" : "Join profile"}</button>
              </form>
            )}
          </div>
          <div className="sidebar-user">
            <span className="avatar">{me.name?.slice(0, 1).toUpperCase() || "C"}</span>
            <span className="sidebar-user-name"><strong>{me.name}</strong><small>Signed in</small></span>
            <button className="icon-button" aria-label="Sign out" title="Sign out" onClick={onLogout}><LogOut size={17} /></button>
          </div>
        </div>
      </aside>
    </>
  );
}

function DoseCard({ dose, zone, now, graceMinutes, onDose, editable, featured = false }) {
  const status = doseStatus(dose, now, graceMinutes);
  return (
    <article className={`dose-card ${featured ? "dose-card-featured" : ""} ${dose.status !== "pending" ? "dose-card-complete" : ""}`}>
      <div className="dose-card-main">
        <span className={`status-pill status-${status.toLowerCase().replaceAll(" ", "-")}`}>
          <span className="status-dot" />{status}
        </span>
        <h3>{dose.name}</h3>
        <p className="dose-description">{dose.dose}</p>
        <div className="dose-meta"><Clock3 size={15} /> {formatTime(dose.due_at, zone)}{dateKey(dose.due_at, zone) !== dateKey(now, zone) && ` · ${formatDate(dose.due_at, zone, { year: "numeric" })}`}</div>
        {dose.instructions && <p className="dose-instructions">{dose.instructions}</p>}
      </div>
      {editable && (
        <div className="dose-actions">
          {dose.status === "pending" ? (
            <>
              <button className="button button-primary" onClick={() => onDose(dose, "taken")}><Check size={16} /> Taken</button>
              <button className="button button-secondary" onClick={() => onDose(dose, "skipped")}>Skip</button>
            </>
          ) : (
            <button className="button button-quiet" onClick={() => onDose(dose, "pending")}>Undo report</button>
          )}
        </div>
      )}
    </article>
  );
}

function AssistantPanel({ profileId, request, notify, onChanged }) {
  const [text, setText] = useState("");
  const [answer, setAnswer] = useState(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [speechUrl, setSpeechUrl] = useState("");
  const recorder = useRef(null);
  const chunks = useRef([]);

  useEffect(() => () => {
    if (speechUrl) URL.revokeObjectURL(speechUrl);
  }, [speechUrl]);

  const ask = async (value) => {
    const question = value.trim();
    if (!question) return;
    setBusy(true);
    setAnswer(null);
    setSpeechUrl("");
    try {
      const result = await request(`/profiles/${profileId}/assistant`, {
        method: "POST",
        body: { text: question },
      });
      setAnswer(result);
      setText("");
    } catch (error) {
      notify(messageFromError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const transcribe = async (blob) => {
    setBusy(true);
    try {
      const context = new window.AudioContext();
      const audioBuffer = await context.decodeAudioData(await blob.arrayBuffer());
      const wav = createWav(audioBuffer);
      await context.close();
      const formData = new FormData();
      formData.append("audio", wav, "care-request.wav");
      const result = await request(`/profiles/${profileId}/voice/transcribe`, {
        method: "POST",
        body: formData,
      });
      setText(result.text);
      await ask(result.text);
    } catch (error) {
      notify(messageFromError(error), "error");
    } finally {
      setBusy(false);
      setRecording(false);
    }
  };

  const toggleRecording = async () => {
    if (recording && recorder.current) {
      recorder.current.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder || !window.AudioContext) {
      notify("Audio recording is not supported in this browser. You can type your question instead.", "error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new window.MediaRecorder(stream);
      recorder.current = mediaRecorder;
      chunks.current = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size) chunks.current.push(event.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        await transcribe(new Blob(chunks.current, { type: mediaRecorder.mimeType }));
      };
      mediaRecorder.start();
      setRecording(true);
    } catch (error) {
      notify(error.name === "NotAllowedError" ? "Microphone access was denied. Allow access or type your question." : messageFromError(error), "error");
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await request(`/profiles/${profileId}/assistant/confirm/${answer.confirmation_id}`, { method: "POST" });
      setAnswer(result);
      onChanged();
      notify(result.message, "success");
    } catch (error) {
      notify(messageFromError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const speak = async () => {
    setBusy(true);
    try {
      const audio = await request(`/profiles/${profileId}/voice/speak`, {
        method: "POST",
        body: { text: answer.message.slice(0, 2000) },
      });
      setSpeechUrl(URL.createObjectURL(audio));
    } catch (error) {
      notify(messageFromError(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="assistant-card">
      <div className="assistant-heading">
        <div className="assistant-icon"><Sparkles size={19} /></div>
        <div><h2>Ask CareCircle</h2><p>Questions about saved doses or appointments. No medical advice.</p></div>
      </div>
      <form className="assistant-input-row" onSubmit={(event) => { event.preventDefault(); ask(text); }}>
        <input aria-label="Ask CareCircle" value={text} onChange={(event) => setText(event.target.value)} placeholder="Try “What is due today?”" />
        <button className={`button ${recording ? "button-recording" : "button-secondary"} assistant-mic`} type="button" aria-label={recording ? "Stop recording" : "Record a question"} onClick={toggleRecording} disabled={busy}>
          {recording ? <span className="recording-dot" /> : <Mic size={17} />}
          <span>{recording ? "Stop" : "Speak"}</span>
        </button>
        <button className="button button-primary assistant-send" type="submit" disabled={busy || !text.trim()}>{busy ? "Working…" : "Ask"} <ArrowRight size={16} /></button>
      </form>
      <div className="assistant-suggestions">
        {["What is due today?", "When is my next appointment?"].map((suggestion) => (
          <button key={suggestion} className="suggestion-chip" onClick={() => ask(suggestion)} disabled={busy}>{suggestion}</button>
        ))}
      </div>
      {answer && (
        <div className="assistant-answer" role="status">
          <p>{answer.message}</p>
          <div className="assistant-answer-actions">
            {!answer.confirmation_id && <button className="button button-secondary button-small" onClick={speak} disabled={busy}><Activity size={14} /> Listen</button>}
            {answer.confirmation_id && (
            <button className="button button-primary button-small" onClick={confirm} disabled={busy}>
              Confirm action <ArrowRight size={15} />
            </button>
            )}
          </div>
        </div>
      )}
      {speechUrl && <audio className="assistant-audio" controls src={speechUrl}>Audio response</audio>}
      <p className="assistant-privacy">Your recording is sent to the configured speech service for transcription. It is not saved by this screen.</p>
    </section>
  );
}

function FollowupCard({ item, zone, editable, owner, currentUserId, request, notify, onChanged }) {
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (path, body, success) => {
    setBusy(true);
    try {
      await request(path, { method: "POST", body });
      notify(success, "success");
      onChanged();
    } catch (error) {
      notify(messageFromError(error), "error");
    } finally {
      setBusy(false);
    }
  };
  const canResolve = owner || item.claimed_by === currentUserId;
  return (
    <article className="followup-card">
      <div className="followup-marker"><HeartHandshake size={17} /></div>
      <div className="followup-content">
        <p>{item.message}</p>
        <small>{formatDate(item.created_at, zone, { year: "numeric" })} · {formatTime(item.created_at, zone)}</small>
        {item.resolved_at ? (
          <span className="resolved-note"><Check size={14} /> Resolved · {item.outcome}</span>
        ) : (
          <span className="followup-assignee">{item.claimed_name ? `Following up: ${item.claimed_name}` : "Awaiting acknowledgement"}</span>
        )}
        {!item.resolved_at && editable && (
          <div className="followup-actions">
            {!item.claimed_by && <button className="button button-secondary button-small" disabled={busy} onClick={() => submit(`/profiles/${item.profile_id}/followups/${item.id}/claim`, undefined, "Check-in acknowledged.")}>I’ll check in</button>}
            {canResolve && (
              <form className="outcome-form" onSubmit={(event) => { event.preventDefault(); if (outcome.trim()) submit(`/profiles/${item.profile_id}/followups/${item.id}/resolve`, { outcome }, "Check-in outcome recorded."); }}>
                <input aria-label="Check-in outcome" value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="Outcome, e.g. spoke with Meera" />
                <button className="icon-button" type="submit" aria-label="Record outcome" disabled={busy || !outcome.trim()}><Check size={17} /></button>
              </form>
            )}
          </div>
        )}
      </div>
    </article>
  );
}

function TodayPage({ dashboard, me, role, profileId, request, notify, onChanged, onDose }) {
  const [checkinConfirmation, setCheckinConfirmation] = useState(null);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const profile = dashboard.profile;
  const zone = profile.timezone;
  const now = new Date(dashboard.now);
  const todayKey = dateKey(now, zone);
  const todayDoses = dashboard.doses.filter((dose) => dateKey(dose.due_at, zone) === todayKey);
  const pending = dashboard.doses
    .filter((dose) => dose.status === "pending")
    .sort((left, right) => new Date(left.due_at) - new Date(right.due_at));
  const attention = pending.filter((dose) => new Date(dose.due_at).getTime() + profile.grace_minutes * 60_000 < now.getTime());
  const openFollowups = dashboard.followups.filter((item) => !item.resolved_at);
  const upcoming = dashboard.appointments[0];
  const isOwner = role === "owner";
  const editable = role === "owner" || role === "editor";
  const firstName = (profile.name || me.name).split(" ")[0];

  return (
    <div className="page-content">
      <header className="page-heading animate-in">
        <div>
          <span className="eyebrow">{new Intl.DateTimeFormat("en-IN", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(now)}</span>
          <h1>{isOwner ? `Good day, ${firstName}` : `${profile.name}’s care overview`}</h1>
          <p>{isOwner ? "Here’s what matters in your care plan today." : `${roleName(role)} · Updates and check-ins for today`}</p>
        </div>
        <span className={`role-chip role-${role}`}><ShieldCheck size={15} /> {roleName(role)}</span>
      </header>

      {isOwner ? (
        <>
          <section className="owner-hero animate-in">
            <div className="owner-hero-copy">
              <span className="hero-kicker"><Activity size={15} /> YOUR NEXT CARE STEP</span>
              {pending[0] ? (
                <>
                  <h2>{pending[0].name}</h2>
                  <p>{pending[0].dose} <span className="hero-separator">·</span> {formatTime(pending[0].due_at, zone)}</p>
                  <span className={`status-pill status-${doseStatus(pending[0], now, profile.grace_minutes).toLowerCase().replaceAll(" ", "-")}`}>
                    <span className="status-dot" /> {doseStatus(pending[0], now, profile.grace_minutes)}
                  </span>
                  {pending[0].instructions && <p className="hero-instructions">{pending[0].instructions}</p>}
                </>
              ) : (
                <>
                  <h2>{todayDoses.length ? "You’re all caught up" : "Your plan is ready when you are"}</h2>
                  <p>{todayDoses.length ? "Today’s medication reports are complete." : "There are no doses scheduled for today."}</p>
                </>
              )}
            </div>
            {pending[0] && editable && (
              <div className="hero-actions">
                <button className="button button-light" onClick={() => onDose(pending[0], "taken")}><Check size={17} /> I’ve taken it</button>
                <button className="button button-hero-ghost" onClick={() => onDose(pending[0], "skipped")}>Skip this dose</button>
              </div>
            )}
            <div className="hero-decoration"><HeartHandshake size={116} strokeWidth={1} /></div>
          </section>

          <AssistantPanel profileId={profileId} request={request} notify={notify} onChanged={onChanged} />

          <section className="content-section animate-in">
            <div className="section-heading">
              <div><h2>Today’s medication plan</h2><p>{dashboard.taken_count} of {dashboard.today_count} doses recorded as taken</p></div>
              <span className="count-chip">{todayDoses.length} {todayDoses.length === 1 ? "dose" : "doses"}</span>
            </div>
            {todayDoses.length ? (
              <div className="dose-list">
                {todayDoses.filter((dose) => dose.id !== pending[0]?.id).map((dose) => <DoseCard key={dose.id} dose={dose} zone={zone} now={now} graceMinutes={profile.grace_minutes} onDose={onDose} editable={editable} />)}
                {todayDoses.every((dose) => dose.id === pending[0]?.id) && <div className="empty-inline">This is today’s only dose. Use the action above to record it.</div>}
              </div>
            ) : (
              <div className="empty-state"><span className="empty-icon"><Pill size={22} /></span><strong>No medication schedule yet</strong><p>Add your care instructions to see doses here.</p></div>
            )}
          </section>

          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Coming up</h2><p>Your next saved appointment</p></div><CalendarDays size={20} /></div>
            {upcoming ? <AppointmentCard appointment={upcoming} zone={zone} /> : <div className="empty-inline">No upcoming appointments saved.</div>}
          </section>

          {profile.sharing_enabled && profile.contact_id && editable && (
            <>
              <button className="request-checkin-button animate-in" disabled={checkinBusy} onClick={async () => {
                setCheckinBusy(true);
                try {
                  setCheckinConfirmation(await request(`/profiles/${profileId}/assistant`, { method: "POST", body: { text: "Please request a check-in" } }));
                } catch (error) {
                  notify(messageFromError(error), "error");
                } finally {
                  setCheckinBusy(false);
                }
              }}>
                <HeartHandshake size={18} /> {checkinBusy ? "Preparing request…" : "Ask my selected contact to check in"} <ArrowRight size={16} />
              </button>
              {checkinConfirmation && (
                <div className="assistant-answer checkin-confirmation" role="status">
                  <p>{checkinConfirmation.message}</p>
                  {checkinConfirmation.confirmation_id && <button className="button button-primary button-small" onClick={async () => {
                    setCheckinBusy(true);
                    try {
                      const result = await request(`/profiles/${profileId}/assistant/confirm/${checkinConfirmation.confirmation_id}`, { method: "POST" });
                      notify(result.message, "success");
                      setCheckinConfirmation(null);
                      onChanged();
                    } catch (error) {
                      notify(messageFromError(error), "error");
                    } finally {
                      setCheckinBusy(false);
                    }
                  }} disabled={checkinBusy}>Confirm check-in</button>}
                  <button className="button button-quiet button-small" onClick={() => setCheckinConfirmation(null)}>Not now</button>
                </div>
              )}
            </>
          )}
          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Care-circle check-ins</h2><p>{openFollowups.length ? `${openFollowups.length} request${openFollowups.length === 1 ? "" : "s"} need attention` : "Shared support, when you need it"}</p></div><HeartHandshake size={20} /></div>
            {dashboard.followups.length ? (
              <div className="followup-list">
                {dashboard.followups.slice(0, 4).map((item) => <FollowupCard key={item.id} item={{ ...item, profile_id: profileId }} zone={zone} editable={editable} owner={isOwner} currentUserId={me.id} request={request} notify={notify} onChanged={onChanged} />)}
              </div>
            ) : <div className="empty-inline">No check-in requests right now.</div>}
          </section>
        </>
      ) : (
        <>
          <div className="summary-grid animate-in">
            <SummaryCard icon={Bell} label="Needs attention" value={attention.length} detail={attention.length ? "Unconfirmed doses" : "No overdue doses"} tone={attention.length ? "amber" : "green"} />
            <SummaryCard icon={HeartHandshake} label="Open check-ins" value={openFollowups.length} detail={openFollowups.length ? "Waiting for follow-up" : "All clear"} tone={openFollowups.length ? "lavender" : "green"} />
            <SummaryCard icon={CheckCheck} label="Taken today" value={`${dashboard.taken_count}/${dashboard.today_count}`} detail="Dose reports" tone="blue" />
          </div>
          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Needs attention</h2><p>Older unconfirmed doses appear first</p></div><ArrowDownRight size={20} /></div>
            {attention.length ? (
              <div className="dose-list">
                {attention.map((dose) => <DoseCard key={dose.id} dose={dose} zone={zone} now={now} graceMinutes={profile.grace_minutes} onDose={onDose} editable={editable} />)}
              </div>
            ) : <div className="empty-inline">No overdue doses need attention.</div>}
          </section>
          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Care-circle check-ins</h2><p>See who has acknowledged each request</p></div><HeartHandshake size={20} /></div>
            {dashboard.followups.length ? (
              <div className="followup-list">
                {dashboard.followups.slice(0, 5).map((item) => <FollowupCard key={item.id} item={{ ...item, profile_id: profileId }} zone={zone} editable={editable} owner={false} currentUserId={me.id} request={request} notify={notify} onChanged={onChanged} />)}
              </div>
            ) : <div className="empty-inline">No check-in requests right now.</div>}
          </section>
          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Today’s medication plan</h2><p>{dashboard.taken_count} of {dashboard.today_count} doses recorded as taken</p></div><span className="count-chip">{todayDoses.length} doses</span></div>
            {todayDoses.length ? (
              <div className="dose-list">
                {todayDoses.filter((dose) => !attention.some((item) => item.id === dose.id)).map((dose) => <DoseCard key={dose.id} dose={dose} zone={zone} now={now} graceMinutes={profile.grace_minutes} onDose={onDose} editable={editable} />)}
              </div>
            ) : <div className="empty-inline">No doses are scheduled for today.</div>}
          </section>
          <section className="content-section animate-in">
            <div className="section-heading"><div><h2>Upcoming appointments</h2><p>Saved visits for this care profile</p></div><CalendarDays size={20} /></div>
            {dashboard.appointments.length ? dashboard.appointments.slice(0, 3).map((appointment) => <AppointmentCard key={appointment.id} appointment={appointment} zone={zone} />) : <div className="empty-inline">No upcoming appointments saved.</div>}
          </section>
          {editable && <AssistantPanel profileId={profileId} request={request} notify={notify} onChanged={onChanged} />}
          {role === "viewer" && <div className="readonly-note"><ShieldCheck size={17} /> You have view-only access. The profile owner manages care records and sharing.</div>}
        </>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, label, value, detail, tone }) {
  return (
    <article className="summary-card">
      <span className={`summary-icon summary-${tone}`}><Icon size={19} /></span>
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
      <span className="summary-detail">{detail}</span>
    </article>
  );
}

function AppointmentCard({ appointment, zone }) {
  return (
    <article className="appointment-card">
      <div className="appointment-date">
        <span>{formatDate(appointment.scheduled_at, zone, { month: "short" })}</span>
        <strong>{new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "2-digit" }).format(new Date(appointment.scheduled_at))}</strong>
      </div>
      <div className="appointment-info">
        <strong>{appointment.doctor}</strong>
        <span>{formatTime(appointment.scheduled_at, zone)}{appointment.location && ` · ${appointment.location}`}</span>
        {appointment.notes && <small>{appointment.notes}</small>}
      </div>
      <CalendarDays className="appointment-icon" size={19} />
    </article>
  );
}

function PageTitle({ eyebrow, title, description, action }) {
  return (
    <header className="page-heading animate-in">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action}
    </header>
  );
}

function MedicationPage({ profileId, medications, zone, editable, request, notify, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const begin = (item = null) => {
    setEditing(item || {});
    setForm(item ? {
      name: item.name,
      dose: item.dose,
      instructions: item.instructions || "",
      times: parseTimes(item.times),
      start_date: item.start_date,
      end_date: item.end_date || "",
      active: Boolean(item.active),
    } : { name: "", dose: "", instructions: "", times: "08:00", start_date: currentDate(zone), end_date: "", active: true });
  };
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const save = async (event) => {
    event.preventDefault();
    const payload = {
      ...form,
      times: form.times.split(",").map((time) => time.trim()).filter(Boolean),
      end_date: form.end_date || null,
      revision: editing?.id ? editing.revision : null,
    };
    try {
      await request(`/profiles/${profileId}/medications${editing?.id ? `/${editing.id}` : ""}`, {
        method: editing?.id ? "PUT" : "POST",
        body: payload,
      });
      notify("Medication schedule saved.", "success");
      setEditing(null);
      onChanged();
    } catch (error) {
      notify(messageFromError(error), "error");
    }
  };

  return (
    <div className="page-content">
      <PageTitle eyebrow="CARE PLAN" title="Medications" description="Keep the saved schedule clear and up to date." action={editable && <button className="button button-primary" onClick={() => begin()}><Plus size={17} /> Add medication</button>} />
      {editing !== null && editable && (
        <section className="editor-panel animate-in">
          <div className="editor-heading"><div><span className="eyebrow">{editing.id ? "EDIT SCHEDULE" : "NEW SCHEDULE"}</span><h2>{editing.id ? editing.name : "Add a medication"}</h2></div><button className="icon-button" aria-label="Close form" onClick={() => setEditing(null)}><X size={19} /></button></div>
          <form className="form-grid" onSubmit={save}>
            <label>Medication name<input required maxLength={120} value={form.name} onChange={update("name")} placeholder="Name as written on the package" /></label>
            <label>Prescribed dose<input required maxLength={120} value={form.dose} onChange={update("dose")} placeholder="Use the prescribed instructions" /></label>
            <label className="form-span">Instructions<textarea maxLength={1000} value={form.instructions} onChange={update("instructions")} placeholder="Optional notes from your care instructions" /></label>
            <label>Daily times, 24-hour format<input required value={form.times} onChange={update("times")} placeholder="08:00, 20:00" /><small>Separate times with commas.</small></label>
            <label>Start date<input type="date" required value={form.start_date} onChange={update("start_date")} /></label>
            <label>End date (optional)<input type="date" value={form.end_date} onChange={update("end_date")} /></label>
            <label className="check-label"><input type="checkbox" checked={form.active} onChange={update("active")} /> Keep this schedule active</label>
            <div className="form-actions form-span"><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="button button-primary">Save schedule</button></div>
          </form>
        </section>
      )}
      <div className="medication-grid">
        {medications.map((medication) => (
          <article className={`medication-card ${!medication.active ? "medication-inactive" : ""}`} key={medication.id}>
            <div className="medication-card-top"><span className="medication-icon"><Pill size={20} /></span><span className={`text-status ${medication.active ? "text-status-active" : ""}`}>{medication.active ? "Active" : "Inactive"}</span></div>
            <h2>{medication.name}</h2><p className="medication-dose">{medication.dose}</p>
            <div className="medication-times"><Clock3 size={15} /> {parseTimes(medication.times) || "No times set"}</div>
            {medication.instructions && <p className="medication-instructions">{medication.instructions}</p>}
            <div className="medication-dates">From {formatDate(medication.start_date, zone, { year: "numeric" })}{medication.end_date && ` · Until ${formatDate(medication.end_date, zone, { year: "numeric" })}`}</div>
            {editable && <button className="button button-secondary medication-edit" onClick={() => begin(medication)}>Edit schedule <ArrowRight size={15} /></button>}
          </article>
        ))}
        {!medications.length && <div className="empty-state"><span className="empty-icon"><Pill size={22} /></span><strong>No medication schedules yet</strong><p>Add a schedule using the care instructions provided by your clinician.</p></div>}
      </div>
    </div>
  );
}

function AppointmentPage({ profileId, appointments, zone, editable, request, notify, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const begin = (item = null) => {
    setEditing(item || {});
    setForm(item ? {
      doctor: item.doctor,
      location: item.location || "",
      notes: item.notes || "",
      scheduled_at: formatDateTimeLocal(item.scheduled_at, zone),
      cancelled: Boolean(item.cancelled),
    } : { doctor: "", location: "", notes: "", scheduled_at: formatDateTimeLocal(new Date(Date.now() + 86_400_000).toISOString(), zone), cancelled: false });
  };
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const save = async (event) => {
    event.preventDefault();
    const payload = { ...form, scheduled_at: zonedDateTimeToIso(form.scheduled_at, zone), revision: editing?.id ? editing.revision : null };
    try {
      await request(`/profiles/${profileId}/appointments${editing?.id ? `/${editing.id}` : ""}`, { method: editing?.id ? "PUT" : "POST", body: payload });
      notify("Appointment saved.", "success");
      setEditing(null);
      onChanged();
    } catch (error) {
      notify(messageFromError(error), "error");
    }
  };

  return (
    <div className="page-content">
      <PageTitle eyebrow="CARE PLAN" title="Appointments" description="Keep visits, locations, and preparation notes together." action={editable && <button className="button button-primary" onClick={() => begin()}><Plus size={17} /> Add appointment</button>} />
      {editing !== null && editable && (
        <section className="editor-panel animate-in">
          <div className="editor-heading"><div><span className="eyebrow">{editing.id ? "EDIT VISIT" : "NEW VISIT"}</span><h2>{editing.id ? editing.doctor : "Add an appointment"}</h2></div><button className="icon-button" aria-label="Close form" onClick={() => setEditing(null)}><X size={19} /></button></div>
          <form className="form-grid" onSubmit={save}>
            <label>Doctor or clinic<input required maxLength={120} value={form.doctor} onChange={update("doctor")} /></label>
            <label>Date and time<input required type="datetime-local" value={form.scheduled_at} onChange={update("scheduled_at")} /></label>
            <label>Location<input maxLength={250} value={form.location} onChange={update("location")} /></label>
            <label className="form-span">Preparation notes<textarea maxLength={1000} value={form.notes} onChange={update("notes")} /></label>
            {editing.id && <label className="check-label"><input type="checkbox" checked={form.cancelled} onChange={update("cancelled")} /> Mark this appointment as cancelled</label>}
            <div className="form-actions form-span"><button type="button" className="button button-secondary" onClick={() => setEditing(null)}>Cancel</button><button type="submit" className="button button-primary">Save appointment</button></div>
          </form>
        </section>
      )}
      <div className="appointment-list">
        {appointments.map((appointment) => (
          <article className={`appointment-card appointment-card-large ${appointment.cancelled ? "appointment-cancelled" : ""}`} key={appointment.id}>
            <div className="appointment-date"><span>{formatDate(appointment.scheduled_at, zone, { month: "short" })}</span><strong>{new Intl.DateTimeFormat("en-IN", { timeZone: zone, day: "2-digit" }).format(new Date(appointment.scheduled_at))}</strong></div>
            <div className="appointment-info"><strong>{appointment.doctor}</strong><span>{formatDate(appointment.scheduled_at, zone, { year: "numeric" })} · {formatTime(appointment.scheduled_at, zone)}</span>{appointment.location && <small>{appointment.location}</small>}{appointment.notes && <small>{appointment.notes}</small>}{appointment.cancelled && <span className="cancelled-label">Cancelled</span>}</div>
            {editable && <button className="button button-secondary appointment-edit" onClick={() => begin(appointment)}>Edit</button>}
          </article>
        ))}
        {!appointments.length && <div className="empty-state"><span className="empty-icon"><CalendarDays size={22} /></span><strong>No appointments saved</strong><p>Add a visit so your care circle can plan ahead.</p></div>}
      </div>
    </div>
  );
}

function CareCirclePage({ profileId, profile, members, role, request, notify, onChanged }) {
  const [inviteRole, setInviteRole] = useState("editor");
  const [invitation, setInvitation] = useState("");
  const [prefs, setPrefs] = useState(() => ({
    email_enabled: Boolean(profile.email_enabled),
    sharing_enabled: Boolean(profile.sharing_enabled),
    contact_id: profile.contact_id || "",
    upcoming_minutes: profile.upcoming_minutes,
    grace_minutes: profile.grace_minutes,
    followup_minutes: profile.followup_minutes,
    appointment_hours: profile.appointment_hours,
  }));
  useEffect(() => {
    setPrefs({
      email_enabled: Boolean(profile.email_enabled),
      sharing_enabled: Boolean(profile.sharing_enabled),
      contact_id: profile.contact_id || "",
      upcoming_minutes: profile.upcoming_minutes,
      grace_minutes: profile.grace_minutes,
      followup_minutes: profile.followup_minutes,
      appointment_hours: profile.appointment_hours,
    });
  }, [profile]);
  const owner = role === "owner";
  const activeEditors = members.filter((member) => member.active && member.role === "editor");
  const invite = async () => {
    try {
      const result = await request(`/profiles/${profileId}/invitations`, { method: "POST", body: { role: inviteRole } });
      setInvitation(result.code);
      notify("Invitation code created. Share it privately.", "success");
    } catch (error) {
      notify(messageFromError(error), "error");
    }
  };
  const updateMember = async (member, roleValue, active) => {
    try {
      await request(`/profiles/${profileId}/members/${member.id}`, { method: "PUT", body: { role: roleValue, active } });
      notify("Member access updated.", "success");
      onChanged();
    } catch (error) {
      notify(messageFromError(error), "error");
    }
  };
  const savePreferences = async (event) => {
    event.preventDefault();
    try {
      await request(`/profiles/${profileId}/preferences`, {
        method: "PUT",
        body: { ...prefs, contact_id: prefs.contact_id ? Number(prefs.contact_id) : null },
      });
      notify("Care preferences saved.", "success");
      onChanged();
    } catch (error) {
      notify(messageFromError(error), "error");
    }
  };
  const changePref = (key) => (event) => setPrefs((current) => ({ ...current, [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  return (
    <div className="page-content">
      <PageTitle eyebrow="SHARED CARE" title="Your care circle" description="Trusted people, clear permissions, and support on your terms." />
      <section className="content-section">
        <div className="section-heading"><div><h2>People with access</h2><p>Access is limited to this care profile.</p></div><UsersRound size={20} /></div>
        <div className="member-list">
          {members.map((member) => (
            <article className="member-row" key={member.id}>
              <span className="avatar member-avatar">{member.name.slice(0, 1).toUpperCase()}</span>
              <div className="member-info"><strong>{member.name}</strong><span>{member.role === "owner" ? "Profile owner" : member.role === "editor" ? "Caretaker · can update records" : "Family · view only"}</span></div>
              <span className={`member-state ${member.active ? "member-active" : ""}`}>{member.active ? "Active" : "Revoked"}</span>
              {owner && member.role !== "owner" && (
                <MemberControls member={member} onSave={updateMember} />
              )}
            </article>
          ))}
        </div>
      </section>
      {owner ? (
        <>
          <section className="content-section invite-section">
            <div className="section-heading"><div><h2>Invite someone you trust</h2><p>Codes can be used once and expire after 24 hours.</p></div><HeartHandshake size={20} /></div>
            <div className="invite-controls">
              <label>Permission<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value)}><option value="editor">Caretaker · can update care</option><option value="viewer">Family · view only</option></select></label>
              <button className="button button-primary" onClick={invite}><Plus size={16} /> Create invite code</button>
            </div>
            {invitation && <div className="invite-code"><code>{invitation}</code><span>Share this code privately.</span><button className="button button-secondary button-small" onClick={() => navigator.clipboard?.writeText(invitation).then(() => notify("Invitation code copied.", "success")).catch(() => notify("Copy failed. Select and copy the code manually.", "error"))}>Copy code</button></div>}
          </section>
          <section className="content-section">
            <div className="section-heading"><div><h2>Reminders and consent</h2><p>You decide when to be reminded and whether to share a check-in.</p></div><Bell size={20} /></div>
            <form className="preferences-form" onSubmit={savePreferences}>
              <label className="preference-toggle"><input type="checkbox" checked={prefs.email_enabled} onChange={changePref("email_enabled")} /><span><strong>Email care reminders</strong><small>Medication and appointment reminders go to your profile email.</small></span></label>
              <label className="preference-toggle"><input type="checkbox" checked={prefs.sharing_enabled} onChange={changePref("sharing_enabled")} /><span><strong>Allow a selected contact to receive check-in requests</strong><small>Check-ins are separate from dose reporting. You can turn sharing off at any time.</small></span></label>
              <label>Selected caretaker<select disabled={!prefs.sharing_enabled} value={prefs.contact_id} onChange={changePref("contact_id")}><option value="">Choose a contact</option>{activeEditors.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
              <div className="preference-grid">
                <label>Upcoming dose reminder · minutes<input type="number" min="1" max="120" value={prefs.upcoming_minutes} onChange={changePref("upcoming_minutes")} /></label>
                <label>Mark unconfirmed after · minutes<input type="number" min="5" max="240" value={prefs.grace_minutes} onChange={changePref("grace_minutes")} /></label>
                <label>Check-in after · minutes<input type="number" min="5" max="480" value={prefs.followup_minutes} onChange={changePref("followup_minutes")} /></label>
                <label>Appointment reminder · hours<input type="number" min="1" max="168" value={prefs.appointment_hours} onChange={changePref("appointment_hours")} /></label>
              </div>
              <div className="form-actions"><button className="button button-primary" type="submit">Save my preferences</button></div>
            </form>
          </section>
        </>
      ) : <div className="readonly-note"><ShieldCheck size={17} /> Only the profile owner can invite people or change sharing preferences.</div>}
    </div>
  );
}

function MemberControls({ member, onSave }) {
  const [role, setRole] = useState(member.role);
  const [active, setActive] = useState(Boolean(member.active));
  return (
    <div className="member-controls">
      <select aria-label={`Permission for ${member.name}`} value={role} onChange={(event) => setRole(event.target.value)}><option value="editor">Caretaker</option><option value="viewer">View only</option></select>
      <label className="member-access"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} /> Access</label>
      {(role !== member.role || active !== Boolean(member.active)) && <button className="button button-secondary button-small" onClick={() => onSave(member, role, active)}>Save</button>}
    </div>
  );
}

function HistoryPage({ history, notifications, owner, zone }) {
  return (
    <div className="page-content">
      <PageTitle eyebrow="TRANSPARENCY" title="Care history" description="A shared record of updates made to this care profile." />
      <section className="content-section">
        <div className="section-heading"><div><h2>Recent activity</h2><p>Changes and care actions, newest first.</p></div><History size={20} /></div>
        {history.length ? (
          <div className="timeline">
            {history.map((item) => (
              <article className="timeline-item" key={item.id}>
                <span className="timeline-dot" />
                <div><strong>{item.action}</strong><span>{item.actor_name} · {formatDate(item.created_at, zone, { year: "numeric" })} · {formatTime(item.created_at, zone)}</span><details><summary>View details</summary><pre>{JSON.stringify(JSON.parse(item.details || "{}"), null, 2)}</pre></details></div>
              </article>
            ))}
          </div>
        ) : <div className="empty-inline">No activity recorded yet.</div>}
      </section>
      {owner && (
        <section className="content-section">
          <div className="section-heading"><div><h2>Email activity</h2><p>Preview saves messages locally; accepted means the SMTP server accepted the message.</p></div><Bell size={20} /></div>
          {notifications.length ? notifications.map((item) => (
            <details className="notification-row" key={item.id}>
              <summary><span className={`text-status ${item.status === "preview" || item.status === "accepted" ? "text-status-active" : ""}`}>{item.status}</span><strong>{item.subject}</strong><small>{item.recipient} · {formatDate(item.created_at, zone, { year: "numeric" })}</small></summary>
              <p>{item.body}</p>
              {item.last_error && <small>Delivery issue: {item.last_error} · attempts {item.attempts}</small>}
            </details>
          )) : <div className="empty-inline">No email activity yet.</div>}
        </section>
      )}
    </div>
  );
}

function App() {
  const [token, setToken] = useState(() => window.sessionStorage.getItem("carecircle_token") || "");
  const [me, setMe] = useState(null);
  const [profileId, setProfileId] = useState("");
  const [page, setPage] = useState("Today");
  const [dashboard, setDashboard] = useState(null);
  const [medications, setMedications] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [members, setMembers] = useState([]);
  const [history, setHistory] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const pageRef = useRef(null);

  const request = useCallback(async (path, options = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const bodyIsForm = options.body instanceof FormData;
    if (options.body && !bodyIsForm) headers["Content-Type"] = "application/json";
    const response = await fetch(`${API_ROOT}${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body ? bodyIsForm ? options.body : JSON.stringify(options.body) : undefined,
    });
    const contentType = response.headers.get("content-type") || "";
    let payload;
    if (response.status === 204) {
      payload = null;
    } else if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => ({}));
    } else if (response.ok) {
      return response.blob();
    } else {
      payload = await response.text().catch(() => "");
    }
    if (response.status === 401 && token) {
      window.sessionStorage.removeItem("carecircle_token");
      setToken("");
    }
    if (!response.ok) {
      const detail = typeof payload === "string" ? payload : payload?.detail;
      throw new Error(Array.isArray(detail) ? detail.map((item) => item.msg).join(" ") : detail || "The request could not be completed.");
    }
    return payload;
  }, [token]);

  const notify = useCallback((text, tone = "success") => {
    setNotice({ text, tone });
    window.setTimeout(() => setNotice((current) => current?.text === text ? null : current), 4500);
  }, []);

  const onAuthenticated = (newToken) => {
    window.sessionStorage.setItem("carecircle_token", newToken);
    setToken(newToken);
    setPage("Today");
  };

  useEffect(() => {
    if (!token) {
      setMe(null);
      setDashboard(null);
      setProfileId("");
      return undefined;
    }
    let active = true;
    request("/me")
      .then((result) => {
        if (!active) return;
        setMe(result);
        setProfileId((current) => result.profiles.some((profile) => String(profile.id) === String(current))
          ? String(current)
          : result.profiles[0] ? String(result.profiles[0].id) : "");
      })
      .catch((error) => notify(messageFromError(error), "error"));
    return () => { active = false; };
  }, [token, request, notify]);

  useEffect(() => {
    if (!token || !profileId || !me) return undefined;
    let active = true;
    const load = async () => {
      setLoading(true);
      setDashboard(null);
      try {
        const path = `/profiles/${profileId}`;
        const data = await request(`${path}/dashboard`);
        if (!active) return;
        setDashboard(data);
        if (page === "Medications") setMedications(await request(`${path}/medications`));
        if (page === "Appointments") setAppointments(await request(`${path}/appointments`));
        if (page === "Care Circle") setMembers(await request(`${path}/members`));
        if (page === "History") {
          setHistory(await request(`${path}/history`));
          setNotifications(data.role === "owner" ? await request(`${path}/notifications`) : []);
        }
      } catch (error) {
        if (active) notify(messageFromError(error), "error");
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    return () => { active = false; };
  }, [token, profileId, me, page, refreshKey, request, notify]);

  useLayoutEffect(() => {
    if (!pageRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return undefined;
    const context = gsap.context(() => {
      gsap.fromTo(".animate-in", { autoAlpha: 0, y: 12 }, {
        autoAlpha: 1,
        y: 0,
        duration: 0.42,
        stagger: 0.07,
        ease: "power2.out",
        clearProps: "transform",
      });
    }, pageRef);
    return () => context.revert();
  }, [page, loading, token]);

  const profile = useMemo(
    () => me?.profiles.find((item) => String(item.id) === String(profileId)),
    [me, profileId],
  );

  const perform = async (path, options, success) => {
    try {
      await request(path, options);
      if (success) notify(success, "success");
      setRefreshKey((current) => current + 1);
      return true;
    } catch (error) {
      notify(messageFromError(error), "error");
      return false;
    }
  };

  const changeDose = (dose, status) => perform(
    `/profiles/${profileId}/doses/${dose.id}`,
    { method: "PUT", body: { status, version: dose.version } },
    status === "taken" ? "Dose recorded as taken." : status === "skipped" ? "Dose recorded as skipped." : "Dose report undone.",
  );

  const logout = async () => {
    try {
      await request("/auth/logout", { method: "POST" });
    } catch (error) {
      notify(`Signed out locally. ${messageFromError(error)}`, "error");
    } finally {
      window.sessionStorage.removeItem("carecircle_token");
      setToken("");
      setPage("Today");
    }
  };

  const joinedCircle = (newProfileId) => {
    request("/me")
      .then((result) => {
        setMe(result);
        setProfileId(String(newProfileId));
        setRefreshKey((current) => current + 1);
        notify("You joined the care circle.", "success");
      })
      .catch((error) => notify(messageFromError(error), "error"));
  };

  if (!token) return <AuthScreen request={request} onAuthenticated={onAuthenticated} />;
  if (!me) return <div className="loading-screen"><span className="loading-mark"><Heart size={20} fill="currentColor" /></span><p>Opening your care space…</p></div>;
  if (!profileId || !profile) return <div className="loading-screen"><p>No active care profile is linked to this account.</p><button className="button button-secondary" onClick={logout}>Sign out</button></div>;

  const role = dashboard?.role || profile.role;
  return (
    <div className="app-shell">
      <Sidebar me={me} profileId={profileId} setProfileId={setProfileId} page={page} setPage={setPage} onLogout={logout} request={request} onChanged={joinedCircle} mobileOpen={mobileOpen} closeMobile={() => setMobileOpen(false)} />
      <main className="workspace">
        <div className="mobile-topbar">
          <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}><Menu size={21} /></button>
          <Brand compact />
          <button className="icon-button" aria-label="Refresh" onClick={() => setRefreshKey((current) => current + 1)}><RefreshCw size={18} /></button>
        </div>
        <header className="topbar">
          <div className="breadcrumb"><span>Care space</span><ArrowRight size={13} /><strong>{page}</strong></div>
          <div className="topbar-actions">
            <span className={`role-chip role-${role}`}><ShieldCheck size={15} /> {roleName(role)}</span>
            <button className="icon-button refresh-button" aria-label="Refresh care information" title="Refresh" onClick={() => setRefreshKey((current) => current + 1)}><RefreshCw size={17} /></button>
            <span className="topbar-avatar">{me.name.slice(0, 1).toUpperCase()}</span>
          </div>
        </header>
        <div className="page-frame" ref={pageRef}>
          <Notice notice={notice} onClose={() => setNotice(null)} />
          {loading ? (
            <div className="loading-inline"><span className="spinner" /> Loading care records…</div>
          ) : dashboard && (
            <>
              {role === "owner" && (!dashboard.worker_heartbeat || Date.now() - new Date(dashboard.worker_heartbeat).getTime() > 5 * 60_000) && (
                <div className="worker-warning" role="status"><Bell size={17} /> Automatic reminders may be paused. Check that the reminder worker is running.</div>
              )}
              {page === "Today" && <TodayPage dashboard={dashboard} me={me} role={role} profileId={profileId} request={request} notify={notify} onChanged={() => setRefreshKey((current) => current + 1)} onDose={changeDose} />}
              {page === "Medications" && <MedicationPage profileId={profileId} medications={medications} zone={profile.timezone} editable={role !== "viewer"} request={request} notify={notify} onChanged={() => setRefreshKey((current) => current + 1)} />}
              {page === "Appointments" && <AppointmentPage profileId={profileId} appointments={appointments} zone={profile.timezone} editable={role !== "viewer"} request={request} notify={notify} onChanged={() => setRefreshKey((current) => current + 1)} />}
              {page === "Care Circle" && <CareCirclePage profileId={profileId} profile={dashboard.profile} members={members} role={role} request={request} notify={notify} onChanged={() => setRefreshKey((current) => current + 1)} />}
              {page === "History" && <HistoryPage history={history} notifications={notifications} owner={role === "owner"} zone={profile.timezone} />}
              {dashboard.worker_heartbeat && <footer className="workspace-footer"><span className="worker-indicator" /> Reminder service active <span>·</span> Times shown in {profile.timezone}</footer>}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
