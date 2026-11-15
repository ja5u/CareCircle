import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bell,
  CalendarDays,
  Clock3,
  HeartHandshake,
  History,
  Pill,
  Plus,
  ShieldCheck,
  UsersRound,
  X,
} from "lucide-react";
import {
  currentDate,
  formatDate,
  formatDateTimeLocal,
  formatTime,
  messageFromError,
  parseTimes,
  zonedDateTimeToIso,
} from "../utils/care.js";

function PageTitle({ eyebrow, title, description, action }) {
  return (
    <header className="page-heading animate-in">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action}
    </header>
  );
}

export function MedicationPage({ profileId, medications, zone, editable, request, notify, onChanged }) {
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

export function AppointmentPage({ profileId, appointments, zone, editable, request, notify, onChanged }) {
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

export function CareCirclePage({ profileId, profile, members, role, request, notify, onChanged }) {
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

export function HistoryPage({ history, notifications, owner, zone }) {
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
