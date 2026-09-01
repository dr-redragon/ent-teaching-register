// ENT Teaching Register - server-side API.
//
// One function, action-routed, because this is run by one person and every extra
// deployable is another thing to keep in step. The boundaries the design calls for
// still exist, as separate handlers: check-in, submit-feedback, send-certificate.
//
// Anonymity: `submit-feedback` passes the trainee's identifier to the
// record_feedback() RPC purely so it can flip attendees.feedback_completed. The
// identifier is never written to feedback_responses, and nothing in this file
// ever reads feedback rows back alongside a name or email.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4?target=deno";
import { emailConfigured, explainFailure, fromEmail, replyToAddresses, sendEmail, usingSandboxSender } from "./email.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Without this the browser re-runs the CORS preflight before EVERY call, and
  // each preflight is a full round trip to a cold isolate -- measured at
  // 180-1260ms, i.e. it was roughly doubling the cost of every organiser action.
  // A day is the most browsers will honour (Chrome caps it at 2 hours anyway).
  "Access-Control-Max-Age": "86400",
};

const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") || "https://register.traineehq.com").replace(/\/+$/, "");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

let _service: SupabaseClient | null = null;
function service(): SupabaseClient {
  return _service ??= createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Organiser-only actions require the caller to be a real, currently-signed-in
// Supabase Auth user — the same login that gates index.html and session.html.
// The client sends that user's own access token as the Authorization bearer
// (not the shared anon key), and getUser() validates it against Auth directly,
// so there is no separate secret to distribute, paste into browsers, or rotate.
async function organiserOk(req: Request): Promise<boolean> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const { data, error } = await service().auth.getUser(token);
  return !error && !!data?.user;
}

// Administrator-only actions (managing organiser accounts) are gated twice: the
// caller must be a signed-in user, as above, AND hold a row in app_admins.
// Hiding the tab in the browser is a convenience for the person looking at it;
// this is the boundary that actually decides who can add or remove an account.
interface Caller { id: string; email: string }
async function adminCaller(req: Request): Promise<Caller | null> {
  const auth = req.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  const db = service();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: row } = await db.from("app_admins")
    .select("user_id").eq("user_id", data.user.id).maybeSingle();
  if (!row) return null;
  return { id: data.user.id, email: data.user.email ?? "" };
}

const cleanEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const cleanText = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

// pdf-lib is ~1MB of JavaScript and only the two certificate actions touch it,
// so it is imported on first use rather than at boot.
async function certificateBuilder() {
  const mod = await import("./certificate.ts");
  return mod.buildCertificatePdf;
}

// A trainee the organiser marked present but for whom the register holds no
// address still needs an attendee row, or they cannot appear on the feedback
// form or be counted. attendees.email is NOT NULL and unique per session, so
// they get a deliberately undeliverable placeholder, recognised again wherever
// we would otherwise try to send to it.
const NO_EMAIL_DOMAIN = "@no-email.invalid";
const placeholderEmail = (key: string) =>
  `t${String(key).replace(/[^a-zA-Z0-9]/g, "").slice(0, 40) || "unknown"}${NO_EMAIL_DOMAIN}`;
const isPlaceholderEmail = (v: string) => String(v ?? "").toLowerCase().endsWith(NO_EMAIL_DOMAIN);

function feedbackUrl(sessionId: string) {
  return `${APP_BASE_URL}/feedback.html?s=${encodeURIComponent(sessionId)}`;
}

/* ------------------------------------------------------------- feedback forms */

// A form is a question list. Validated here rather than trusted from the editor,
// because the same shape is later read by the anonymous feedback page and by the
// report, and a malformed one would break both for everybody.
const QUESTION_TYPES = new Set(["scale", "short", "long", "choice", "checkbox"]);

interface Question {
  id: string; type: string; text: string; required: boolean;
  options?: string[]; lowLabel?: string; highLabel?: string;
  placeholder?: string; locked?: boolean;
}

function cleanForm(raw: unknown): { form: { title: string; questions: Question[] } } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "The form is missing" };
  const src = raw as Record<string, unknown>;
  const list = Array.isArray(src.questions) ? src.questions : null;
  if (!list) return { error: "The form has no questions" };
  if (!list.length) return { error: "A form needs at least one question" };
  if (list.length > 40) return { error: "That is more than 40 questions" };

  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const q = item as Record<string, unknown>;
    const type = String(q.type ?? "scale");
    if (!QUESTION_TYPES.has(type)) return { error: `Unknown question type: ${type}` };

    // Answers are keyed by id, so a duplicate would silently overwrite another
    // question's answers -- and an id that changes orphans historic responses.
    let id = cleanText(q.id, 40).replace(/[^a-zA-Z0-9_]/g, "") || `q${questions.length + 1}`;
    while (seen.has(id)) id = `${id}_${questions.length + 1}`;
    seen.add(id);

    const text = cleanText(q.text, 300);
    if (!text) return { error: "Every question needs some text" };

    const out: Question = { id, type, text, required: q.required === true };
    if (type === "choice" || type === "checkbox") {
      const opts = (Array.isArray(q.options) ? q.options : [])
        .map((o) => cleanText(o, 120)).filter(Boolean).slice(0, 20);
      if (opts.length < 2) return { error: `"${text}" needs at least two options` };
      out.options = opts;
    }
    if (type === "scale") {
      out.lowLabel = cleanText(q.lowLabel, 40) || "Strongly disagree";
      out.highLabel = cleanText(q.highLabel, 40) || "Strongly agree";
    }
    if (type === "short" || type === "long") {
      const ph = cleanText(q.placeholder, 120);
      if (ph) out.placeholder = ph;
    }
    if (q.locked === true) out.locked = true;
    questions.push(out);
  }
  if (!questions.length) return { error: "A form needs at least one question" };
  return { form: { title: cleanText(src.title, 120) || "Session feedback", questions } };
}

async function templateForm(db: SupabaseClient) {
  const { data } = await db.from("form_templates").select("form").eq("id", "default").maybeSingle();
  return data?.form ?? null;
}

// Returns the form the editor should open: the session's own if it has one,
// otherwise the shared template it would inherit.
async function handleGetForm(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const template = await templateForm(db);
  if (!sessionId) return json({ ok: true, form: template, source: "template", template });

  const { data: session } = await db.from("sessions")
    .select("id,title,session_date,form").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 404);
  return json({
    ok: true,
    session: { id: session.id, title: session.title, session_date: session.session_date },
    form: session.form ?? template,
    source: session.form ? "session" : "template",
    template,
  });
}

async function handleSaveForm(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const asTemplate = body.as_template === true;
  const reset = body.reset === true;

  // "Reset to the template" simply drops the session's own copy, so it goes back
  // to inheriting -- and keeps inheriting future template edits.
  if (reset) {
    if (!sessionId) return json({ error: "Missing session" }, 400);
    const { error } = await db.from("sessions").update({ form: null }).eq("id", sessionId);
    if (error) return json({ error: error.message }, 500);
    return json({ ok: true, form: await templateForm(db), source: "template" });
  }

  const checked = cleanForm(body.form);
  if ("error" in checked) return json({ error: checked.error }, 400);

  if (asTemplate) {
    const { error } = await db.from("form_templates")
      .upsert({ id: "default", form: checked.form, updated_at: new Date().toISOString() }, { onConflict: "id" });
    if (error) return json({ error: error.message }, 500);
  }
  if (sessionId) {
    const { error } = await db.from("sessions").update({ form: checked.form }).eq("id", sessionId);
    if (error) return json({ error: error.message }, 500);
  }
  if (!sessionId && !asTemplate) return json({ error: "Nothing to save to" }, 400);

  return json({ ok: true, form: checked.form, source: sessionId ? "session" : "template", saved_template: asTemplate });
}

/* ---------------------------------------------------------------- certificates */

interface CertificateTarget {
  id: string;
  session_id: string;
  name: string;
  email: string;
  checked_in: boolean;
  certificate_sent_at: string | null;
}

// Builds the PDF and emails it, then stamps certificate_sent_at. The stamp is
// conditional on it still being null, so two concurrent submissions can't
// double-send. Returns a short status string for the caller to report.
async function issueCertificate(db: SupabaseClient, attendee: CertificateTarget, force = false): Promise<string> {
  if (!attendee.checked_in) return "skipped_not_checked_in";
  if (isPlaceholderEmail(attendee.email)) return "skipped_no_email";
  if (attendee.certificate_sent_at && !force) return "already_sent";

  const { data: session } = await db
    .from("sessions")
    .select("id,title,session_date,location")
    .eq("id", attendee.session_id)
    .maybeSingle();
  if (!session) return "failed_session_missing";

  if (!emailConfigured()) return "email_not_configured";

  let pdf: Uint8Array;
  try {
    const buildCertificatePdf = await certificateBuilder();
    pdf = await buildCertificatePdf({
      name: attendee.name,
      sessionTitle: session.title,
      sessionDate: session.session_date,
      location: session.location,
      reference: attendee.id.slice(0, 8).toUpperCase(),
      logoUrl: Deno.env.get("CERT_LOGO_URL") || null,
    });
  } catch (err) {
    console.error("certificate build failed", err);
    return "failed_pdf";
  }

  const dateLabel = new Date(session.session_date + "T00:00:00Z")
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  const sent = await sendEmail({
    to: attendee.email,
    subject: `Your attendance certificate - ${session.title}`,
    html: `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:15px;color:#15211c;line-height:1.55">
      <p>Dear ${esc(attendee.name)},</p>
      <p>Thank you for attending <strong>${esc(session.title)}</strong> on ${esc(dateLabel)}, and for completing the feedback form.</p>
      <p>Your certificate of attendance is attached as a PDF.</p>
      <p style="color:#7a7568;font-size:13px">ENT Regional Teaching Programme</p>
    </div>`,
    text: `Dear ${attendee.name},\n\nThank you for attending ${session.title} on ${dateLabel}, and for completing the feedback form. Your certificate is attached.\n\nENT Regional Teaching Programme`,
    attachments: [{ filename: `certificate-${session.session_date}.pdf`, content: pdf }],
  });

  if (!sent.ok) {
    console.error("certificate email failed", sent.error);
    return sent.skipped ? "email_not_configured" : "failed_email";
  }

  const stamp = db.from("attendees").update({ certificate_sent_at: new Date().toISOString() }).eq("id", attendee.id);
  await (force ? stamp : stamp.is("certificate_sent_at", null));
  return "sent";
}

/* -------------------------------------------------------------------- actions */

async function handleCheckIn(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const name = cleanText(body.name, 120);
  const typedEmail = cleanEmail(body.email);
  const grade = cleanText(body.grade, 40) || null;
  const localTraineeId = cleanText(body.local_trainee_id, 64) || null;

  if (!sessionId || !name) return json({ error: "Session and name are required" }, 400);

  const { data: session } = await db.from("sessions").select("id,title,session_date,local_id").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "This sign-in link is not valid any more" }, 404);

  // "My name is not on the list" used to produce an attendee row and nothing
  // else: the register reported them as unmatched at sync time and forgot them.
  // They now join the roster here, as they sign in — marked present for this
  // teaching day and on the list for every future one. Matching inside the
  // function is by name, so typing a name that is already on the roster attaches
  // to that record instead of creating a second one.
  let traineeId = localTraineeId;
  let enrolled = false;
  if (!traineeId) {
    const { data: joined, error: enrolError } = await db.rpc("enrol_local_trainee", {
      p_name: name,
      p_email: typedEmail,
      p_grade: grade ?? "",
      p_session_id: session.local_id,
    });
    if (enrolError) console.error("enrol_local_trainee failed", enrolError);   // attendee row still stands
    const row = joined as { trainee_id?: string | null; created?: boolean } | null;
    if (row?.trainee_id) traineeId = row.trainee_id;
    // `created` is false when the typed name turned out to match somebody
    // already on the roster -- nothing new to tell them about, in that case.
    enrolled = row?.created === true;
  }

  // Resolve the email server-side: a typed address is saved back onto the
  // trainee's roster record (so it's on file next time); a blank one falls back
  // to whatever is already on file. The stored address is never sent to the
  // browser — it only travels as far as the attendee row here, for the
  // certificate. Trainees not on the roster (localTraineeId null) must type one.
  let email = typedEmail;
  try {
    const { data: resolved } = await db.rpc("resolve_trainee_email", {
      p_trainee_id: traineeId,
      p_email: typedEmail,
    });
    if (typeof resolved === "string" && resolved) email = cleanEmail(resolved);
  } catch (err) {
    console.error("resolve_trainee_email failed", err);   // fall back to the typed value
  }

  if (!isEmail(email)) return json({ error: "A valid email address is required" }, 400);

  const { data, error } = await db
    .from("attendees")
    .upsert(
      { session_id: sessionId, name, email, grade, checked_in_at: new Date().toISOString() },
      { onConflict: "session_id,email" },
    )
    .select("id,name")
    .single();

  if (error) {
    console.error("check-in failed", error);
    return json({ error: "Could not record your check-in - please try again" }, 500);
  }
  return json({ ok: true, attendee_id: data.id, name: data.name, session_title: session.title, enrolled });
}

async function handleSubmitFeedback(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const identifier = cleanText(body.identifier, 200);
  const overall = Number(body.overall_rating);
  if (!sessionId) return json({ error: "Missing session" }, 400);
  if (!Number.isInteger(overall) || overall < 1 || overall > 5) {
    return json({ error: "Please give an overall rating" }, 400);
  }

  const answers = (body.answers && typeof body.answers === "object") ? body.answers : {};
  const comments = String(body.comments ?? "").trim().slice(0, 4000);

  // Insert + gate flip happen inside one transaction in the database.
  const { data, error } = await db.rpc("record_feedback", {
    p_session_id: sessionId,
    p_identifier: identifier,
    p_overall: overall,
    p_answers: answers,
    p_comments: comments,
  });
  if (error) {
    console.error("record_feedback failed", error);
    return json({ error: "Could not save your feedback - please try again" }, 500);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row || row.status === "unknown_session") return json({ error: "This feedback link is not valid any more" }, 404);
  if (row.status === "already_submitted") {
    return json({ ok: true, status: "already_submitted", certificate: "already_recorded" });
  }
  if (row.status === "recorded_unmatched") {
    // Feedback is kept - we simply have nobody to issue a certificate to.
    return json({ ok: true, status: "recorded", certificate: "skipped_no_match" });
  }

  const certificate = await issueCertificate(db, {
    id: row.attendee_id,
    session_id: sessionId,
    name: row.attendee_name,
    email: row.attendee_email,
    checked_in: !!row.checked_in,
    certificate_sent_at: row.certificate_sent_at,
  });

  return json({ ok: true, status: "recorded", certificate });
}

async function handleCreateSession(db: SupabaseClient, body: Record<string, unknown>) {
  const title = cleanText(body.title, 200);
  const sessionDate = cleanText(body.session_date, 10);
  const location = cleanText(body.location, 200) || null;
  const localId = cleanText(body.local_id, 64) || null;
  if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    return json({ error: "Title and a valid date are required" }, 400);
  }

  if (localId) {
    const { data: existing } = await db.from("sessions").select("id").eq("local_id", localId).maybeSingle();
    if (existing) {
      const { data, error } = await db.from("sessions")
        .update({ title, session_date: sessionDate, location })
        .eq("id", existing.id).select("*").single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, session: data, created: false });
    }
  }

  // A brand-new session starts from the shared template, so it has a form the
  // moment it is published and can be edited from there without touching it.
  const { data, error } = await db.from("sessions")
    .insert({ title, session_date: sessionDate, location, local_id: localId, form: await templateForm(db) })
    .select("*").single();
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, session: data, created: true });
}

async function handleSessionStatus(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  if (!sessionId) return json({ error: "Missing session" }, 400);
  const { data: session } = await db.from("sessions").select("*").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 404);
  const { data: attendees, error } = await db.from("attendees")
    .select("id,name,email,grade,checked_in_at,feedback_completed,certificate_sent_at")
    .eq("session_id", sessionId)
    .order("name");
  if (error) return json({ error: error.message }, 500);
  return json({
    ok: true, session, attendees,
    email_configured: emailConfigured(),
    email_from: fromEmail(),
    email_sandbox: emailConfigured() && usingSandboxSender(),
    email_reply_to: replyToAddresses(),
    feedback_url: feedbackUrl(sessionId),
  });
}

async function handleSendCertificate(db: SupabaseClient, body: Record<string, unknown>) {
  const attendeeId = cleanText(body.attendee_id, 64);
  const force = body.force === true;
  if (!attendeeId) return json({ error: "Missing attendee" }, 400);
  const { data: attendee } = await db.from("attendees")
    .select("id,session_id,name,email,checked_in_at,feedback_completed,certificate_sent_at")
    .eq("id", attendeeId).maybeSingle();
  if (!attendee) return json({ error: "Unknown attendee" }, 404);
  if (!attendee.feedback_completed && !force) {
    return json({ ok: true, certificate: "skipped_no_feedback" });
  }
  const certificate = await issueCertificate(db, {
    id: attendee.id,
    session_id: attendee.session_id,
    name: attendee.name,
    email: attendee.email,
    checked_in: !!attendee.checked_in_at,
    certificate_sent_at: attendee.certificate_sent_at,
  }, force);
  return json({ ok: true, certificate });
}

// Push the (single, shared) feedback link to people who attended. Optionally to a
// subset. Anyone who has already given feedback is skipped.
async function handleEmailFeedbackLink(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const ids: string[] = Array.isArray(body.attendee_ids) ? body.attendee_ids.map((v) => String(v)) : [];
  if (!sessionId) return json({ error: "Missing session" }, 400);
  if (!emailConfigured()) return json({ error: "Email is not configured yet (RESEND_API_KEY is not set)" }, 400);

  const { data: session } = await db.from("sessions").select("id,title,session_date").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 404);

  let q = db.from("attendees")
    .select("id,name,email,checked_in_at,feedback_completed")
    .eq("session_id", sessionId)
    .not("checked_in_at", "is", null)
    .eq("feedback_completed", false);
  if (ids.length) q = q.in("id", ids);
  const { data: all, error } = await q;
  if (error) return json({ error: error.message }, 500);

  // Anyone marked present without an address on file cannot be emailed. Say so
  // by name rather than reporting a bare failure.
  const targets = (all ?? []).filter((t) => !isPlaceholderEmail(t.email));
  const unreachable = (all ?? []).filter((t) => isPlaceholderEmail(t.email));

  const url = feedbackUrl(sessionId);
  const dateLabel = new Date(session.session_date + "T00:00:00Z")
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  let sent = 0;
  const failures: { name: string; email: string; why: string }[] = unreachable.map((t) => ({
    name: t.name, email: "",
    why: "No email on file — add one on the Trainees & sessions tab, then push again.",
  }));
  for (const t of targets) {
    const res = await sendEmail({
      to: t.email,
      subject: `Feedback for ${session.title} - and your certificate`,
      html: `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:15px;color:#15211c;line-height:1.55">
        <p>Dear ${esc(t.name)},</p>
        <p>Thank you for attending <strong>${esc(session.title)}</strong> on ${esc(dateLabel)}.</p>
        <p>Please complete the short feedback form below. It is anonymous - your answers are stored with no name or email attached. Once it is submitted, your certificate of attendance is emailed to you automatically.</p>
        <p><a href="${url}" style="display:inline-block;background:#2c4d39;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;font-weight:600">Give feedback and get your certificate</a></p>
        <p style="color:#7a7568;font-size:13px">Or paste this into your browser: ${url}</p>
        <p style="color:#7a7568;font-size:13px">ENT Regional Teaching Programme</p>
      </div>`,
      text: `Dear ${t.name},\n\nThank you for attending ${session.title} on ${dateLabel}. Please complete the anonymous feedback form to receive your certificate:\n${url}\n\nENT Regional Teaching Programme`,
    });
    if (res.ok) sent++;
    else failures.push({ name: t.name, email: t.email, why: explainFailure(res.reason) });
  }
  return json({
    ok: true, sent, considered: (all ?? []).length, failures,
    sandbox: usingSandboxSender(), from: fromEmail(),
  });
}

// The organiser ticking someone present in the register is as much a check-in as
// that trainee scanning the QR: without a row here they never appear on the
// feedback form's name list, are never counted, and can never be issued a
// certificate. This is how a manual mark-present reaches Supabase.
async function handleMarkAttended(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  const checkedIn = body.checked_in !== false;          // default: mark present
  const list = Array.isArray(body.trainees) ? body.trainees : [];
  if (!sessionId) return json({ error: "Missing session" }, 400);
  if (!list.length) return json({ ok: true, marked: 0, no_email: [] });

  const { data: session } = await db.from("sessions").select("id").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 404);

  let marked = 0;
  const noEmail: string[] = [];

  for (const raw of list) {
    const item = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
    const name = cleanText(item.name, 120);
    const localId = cleanText(item.local_trainee_id, 64) || null;
    const grade = cleanText(item.grade, 40) || null;
    if (!name) continue;

    let email = cleanEmail(item.email);
    if (!isEmail(email) && localId) {
      try {
        const { data: resolved } = await db.rpc("resolve_trainee_email", { p_trainee_id: localId, p_email: null });
        if (typeof resolved === "string" && resolved) email = cleanEmail(resolved);
      } catch (err) { console.error("resolve_trainee_email failed", err); }
    }
    if (!isEmail(email)) { email = placeholderEmail(localId || name); noEmail.push(name); }

    if (!checkedIn) {
      // Un-ticking someone clears their check-in rather than deleting the row,
      // so any feedback or certificate already recorded against them survives.
      // The anon read policy hides rows with no checked_in_at, so they drop off
      // the feedback form's list.
      await db.from("attendees").update({ checked_in_at: null })
        .eq("session_id", sessionId).eq("email", email);
      marked++;
      continue;
    }

    const { error } = await db.from("attendees").upsert(
      { session_id: sessionId, name, email, grade, checked_in_at: new Date().toISOString() },
      { onConflict: "session_id,email" },
    );
    if (error) { console.error("mark-attended failed", error); continue; }
    marked++;
  }

  return json({ ok: true, marked, no_email: noEmail });
}

// Wipes every feedback response for one session and reopens the gate so it can
// be collected again. Deliberately does not clear certificate_sent_at: those
// emails have already gone out, and re-opening them would send duplicates.
async function handleResetFeedback(db: SupabaseClient, body: Record<string, unknown>) {
  const sessionId = cleanText(body.session_id, 64);
  if (!sessionId) return json({ error: "Missing session" }, 400);
  if (body.confirm !== true) return json({ error: "This needs to be confirmed" }, 400);

  const { data: session } = await db.from("sessions").select("id,title").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "Unknown session" }, 404);

  const { count } = await db.from("feedback_responses")
    .select("id", { count: "exact", head: true }).eq("session_id", sessionId);

  const { error: delErr } = await db.from("feedback_responses").delete().eq("session_id", sessionId);
  if (delErr) { console.error("reset-feedback delete failed", delErr); return json({ error: delErr.message }, 500); }

  const { error: gateErr } = await db.from("attendees")
    .update({ feedback_completed: false }).eq("session_id", sessionId);
  if (gateErr) { console.error("reset-feedback gate failed", gateErr); return json({ error: gateErr.message }, 500); }

  return json({ ok: true, deleted: count ?? 0, session: session.title });
}

// Chases the people the register shows as absent without an excuse. The
// recipient list is worked out in the register (which is where eligibility,
// excuses and long-term status live) and passed in; this end's job is to send
// it as one BCC'd message per batch so no trainee sees who else was chased.
async function handleChaseAbsences(db: SupabaseClient, body: Record<string, unknown>) {
  if (!emailConfigured()) return json({ error: "Email is not configured yet (RESEND_API_KEY is not set)" }, 400);

  const subject = cleanText(body.subject, 300);
  const bodyText = String(body.body ?? "").trim().slice(0, 8000);
  const replyTo = (Array.isArray(body.reply_to) ? body.reply_to : [])
    .map((v) => cleanEmail(v)).filter(isEmail).slice(0, 4);

  const recipients = (Array.isArray(body.recipients) ? body.recipients : [])
    .map((v) => cleanEmail(v)).filter(isEmail);
  const unique = [...new Set(recipients)];

  if (!subject) return json({ error: "The email needs a subject" }, 400);
  if (!bodyText) return json({ error: "The email needs a message" }, 400);
  if (!unique.length) return json({ error: "Nobody to send to" }, 400);
  if (unique.length > 200) return json({ error: "That is more than 200 recipients - split it up" }, 400);

  // Everyone goes in BCC so recipients cannot see each other, which still needs
  // *some* visible To:. It must be an address that actually accepts mail: the
  // To: recipient is delivered to like any other, so pointing it at the sending
  // identity bounces every single send once that identity is a no-reply@ with no
  // mailbox behind it (the usual case — a sending identity needs DNS, not a
  // mailbox). Prefer the reply-to the organiser gave us, which is by definition
  // a real inbox they read, and which doubles as their own copy of the chaser.
  const visibleTo = replyTo[0] || fromEmail();
  const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;font-size:15px;color:#15211c;line-height:1.55">` +
    bodyText.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("") +
    `</div>`;

  // Resend caps a single message at 50 recipients, so send in batches.
  const BATCH = 45;
  let sent = 0;
  const failures: { batch: number; why: string }[] = [];
  for (let i = 0; i < unique.length; i += BATCH) {
    const slice = unique.slice(i, i + BATCH);
    const res = await sendEmail({
      to: visibleTo, bcc: slice, subject, html, text: bodyText,
      replyTo: replyTo.length ? replyTo : undefined,
    });
    if (res.ok) sent += slice.length;
    else failures.push({ batch: Math.floor(i / BATCH) + 1, why: explainFailure(res.reason) });
  }

  return json({
    ok: true, sent, considered: unique.length, failures,
    sandbox: usingSandboxSender(), from: fromEmail(),
    visible_to: visibleTo,
    reply_to: replyTo,
  });
}

// Renders a certificate without sending anything, so the design can be checked.
async function handleCertificatePreview(db: SupabaseClient, body: Record<string, unknown>) {
  const name = cleanText(body.name, 120) || "Dr Example Trainee";
  let title = cleanText(body.title, 200) || "ENT Regional Teaching Day";
  let date = cleanText(body.session_date, 10);
  let location = cleanText(body.location, 200) || null;
  const sessionId = cleanText(body.session_id, 64);
  if (sessionId) {
    const { data: s } = await db.from("sessions").select("title,session_date,location").eq("id", sessionId).maybeSingle();
    if (s) { title = s.title; date = s.session_date; location = s.location; }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = new Date().toISOString().slice(0, 10);

  const buildCertificatePdf = await certificateBuilder();
  const pdf = await buildCertificatePdf({
    name, sessionTitle: title, sessionDate: date, location,
    reference: "PREVIEW", logoUrl: Deno.env.get("CERT_LOGO_URL") || null,
  });
  return new Response(pdf, {
    headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="certificate-preview.pdf"' },
  });
}

/* ------------------------------------------------------------ organiser accounts */

// GoTrue's own wording is written for developers ("A user with this email
// address has already been registered"); these are read by whoever is running
// the teaching programme.
function friendlyAuthError(message: string): string {
  const m = String(message ?? "");
  if (/already.*(registered|exists)/i.test(m)) return "There is already an account with that email address.";
  if (/password/i.test(m) && /short|least|weak/i.test(m)) return "That password is too short — use at least 8 characters.";
  if (/rate limit|too many/i.test(m)) return "Too many requests in a row — wait a minute and try again.";
  return m || "Something went wrong";
}

// The whole account list, with an is_admin flag. auth.users is never exposed to
// the browser directly; this is the only way the register sees it, and only
// administrators reach it.
async function handleAdminListUsers(db: SupabaseClient) {
  const users: Record<string, unknown>[] = [];
  // listUsers() is paged. Ten pages of 200 is far more than this register will
  // ever hold, and it stops as soon as a short page comes back.
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return json({ error: error.message }, 500);
    const batch = data?.users ?? [];
    users.push(...(batch as unknown as Record<string, unknown>[]));
    if (batch.length < 200) break;
  }

  const { data: admins } = await db.from("app_admins").select("user_id");
  const adminIds = new Set((admins ?? []).map((a: { user_id: string }) => a.user_id));

  const list = users.map((u) => ({
    id: String(u.id),
    email: String(u.email ?? ""),
    is_admin: adminIds.has(String(u.id)),
    created_at: u.created_at ?? null,
    last_sign_in_at: u.last_sign_in_at ?? null,
    invited_at: u.invited_at ?? null,
    // An invited account that has never followed its link has no confirmed
    // address and no password yet -- worth showing, since it explains why the
    // person says they cannot sign in.
    confirmed: !!(u.email_confirmed_at || u.confirmed_at),
  })).sort((a, b) => a.email.localeCompare(b.email));

  return json({ ok: true, users: list });
}

// Two ways to add someone, because both come up: email them an invite and let
// them choose their own password, or set one now and tell them what it is
// (useful when the address cannot receive mail from Supabase).
async function handleAdminCreateUser(db: SupabaseClient, body: Record<string, unknown>, caller: Caller) {
  const email = cleanEmail(body.email);
  if (!isEmail(email)) return json({ error: "That does not look like a valid email address" }, 400);
  const password = String(body.password ?? "");
  if (password && password.length < 8) return json({ error: "A password needs at least 8 characters" }, 400);

  let userId: string | null = null;
  if (password) {
    const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) return json({ error: friendlyAuthError(error.message) }, 400);
    userId = data?.user?.id ?? null;
  } else {
    const { data, error } = await db.auth.admin.inviteUserByEmail(email, { redirectTo: `${APP_BASE_URL}/index.html` });
    if (error) return json({ error: friendlyAuthError(error.message) }, 400);
    userId = data?.user?.id ?? null;
  }

  if (body.admin === true && userId) {
    const { error } = await db.from("app_admins").upsert({ user_id: userId, email, granted_by: caller.id });
    if (error) return json({ error: "The account was created, but granting administrator access failed" }, 500);
  }
  return json({ ok: true, invited: !password, user_id: userId });
}

async function handleAdminUpdateUser(db: SupabaseClient, body: Record<string, unknown>, caller: Caller) {
  const userId = cleanText(body.user_id, 64);
  if (!userId) return json({ error: "Which account?" }, 400);
  const { data: found, error: findErr } = await db.auth.admin.getUserById(userId);
  if (findErr || !found?.user) return json({ error: "That account no longer exists" }, 404);

  const attrs: Record<string, unknown> = {};
  let newEmail: string | null = null;
  if (body.email !== undefined) {
    const email = cleanEmail(body.email);
    if (!isEmail(email)) return json({ error: "That does not look like a valid email address" }, 400);
    if (email !== cleanEmail(found.user.email)) {
      // email_confirm keeps the account usable straight away: without it the
      // address sits unconfirmed until a link is followed, and the person is
      // locked out of a register they could use a moment ago.
      attrs.email = email;
      attrs.email_confirm = true;
      newEmail = email;
    }
  }
  if (body.password !== undefined && String(body.password)) {
    const pw = String(body.password);
    if (pw.length < 8) return json({ error: "A password needs at least 8 characters" }, 400);
    attrs.password = pw;
  }
  if (Object.keys(attrs).length) {
    const { error } = await db.auth.admin.updateUserById(userId, attrs);
    if (error) return json({ error: friendlyAuthError(error.message) }, 400);
  }

  if (body.admin !== undefined) {
    const wantAdmin = body.admin === true;
    // Removing your own administrator access is the one change that cannot be
    // undone from inside the app, so it is refused outright rather than warned
    // about. Another administrator can still do it for you.
    if (!wantAdmin && userId === caller.id) {
      return json({ error: "You cannot remove your own administrator access — ask another administrator to do it." }, 400);
    }
    if (wantAdmin) {
      const email = newEmail ?? cleanEmail(found.user.email);
      const { error } = await db.from("app_admins").upsert({ user_id: userId, email, granted_by: caller.id });
      if (error) return json({ error: "Could not grant administrator access" }, 500);
    } else {
      const { error } = await db.from("app_admins").delete().eq("user_id", userId);
      if (error) return json({ error: "Could not remove administrator access" }, 500);
    }
  } else if (newEmail) {
    await db.from("app_admins").update({ email: newEmail }).eq("user_id", userId);
  }
  return json({ ok: true });
}

async function handleAdminDeleteUser(db: SupabaseClient, body: Record<string, unknown>, caller: Caller) {
  const userId = cleanText(body.user_id, 64);
  if (!userId) return json({ error: "Which account?" }, 400);
  // Also what stops the last administrator being deleted: only an administrator
  // gets this far, and they cannot be the target.
  if (userId === caller.id) return json({ error: "You cannot delete your own account." }, 400);
  const { error } = await db.auth.admin.deleteUser(userId);
  if (error) return json({ error: friendlyAuthError(error.message) }, 400);
  // app_admins cascades on the auth.users delete; this is belt and braces.
  await db.from("app_admins").delete().eq("user_id", userId);
  return json({ ok: true });
}

// The same email the sign-in page's "Forgot password?" sends, triggered on
// someone else's behalf -- so an administrator never has to know or invent a
// password for them.
async function handleAdminSendReset(db: SupabaseClient, body: Record<string, unknown>) {
  const email = cleanEmail(body.email);
  if (!isEmail(email)) return json({ error: "That does not look like a valid email address" }, 400);
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo: `${APP_BASE_URL}/index.html` });
  if (error) return json({ error: friendlyAuthError(error.message) }, 400);
  return json({ ok: true });
}

/* --------------------------------------------------------------------- router */

const ORGANISER_ACTIONS = new Set([
  "create-session", "session-status", "send-certificate", "email-feedback-link", "certificate-preview",
  "chase-absences", "get-form", "save-form", "mark-attended", "reset-feedback",
  // check-in writes attendance and can add names to the roster, and this function
  // runs as service_role, so leaving it ungated let anyone holding the publishable
  // key record attendance for anybody. Organisers mark attendance from the console.
  "check-in",
]);

// A stricter tier than the above: signing in is not enough, the caller has to be
// an administrator too.
const ADMIN_ACTIONS = new Set([
  "admin-list-users", "admin-create-user", "admin-update-user", "admin-delete-user", "admin-send-reset",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const action = String(body.action ?? "");
  // Resolved once here rather than inside each handler: the admin handlers need
  // to know who is asking, to refuse the two changes that would lock an
  // administrator out of their own register.
  let caller: Caller | null = null;
  if (ADMIN_ACTIONS.has(action)) {
    caller = await adminCaller(req);
    if (!caller) return json({ error: "Administrator access is needed to manage accounts" }, 403);
  } else if (ORGANISER_ACTIONS.has(action) && !(await organiserOk(req))) {
    return json({ error: "Please sign in to do this" }, 401);
  }

  const db = service();
  try {
    switch (action) {
      case "check-in":            return await handleCheckIn(db, body);
      case "submit-feedback":     return await handleSubmitFeedback(db, body);
      case "create-session":      return await handleCreateSession(db, body);
      case "session-status":      return await handleSessionStatus(db, body);
      case "send-certificate":    return await handleSendCertificate(db, body);
      case "email-feedback-link": return await handleEmailFeedbackLink(db, body);
      case "certificate-preview": return await handleCertificatePreview(db, body);
      case "chase-absences":      return await handleChaseAbsences(db, body);
      case "get-form":            return await handleGetForm(db, body);
      case "save-form":           return await handleSaveForm(db, body);
      case "mark-attended":       return await handleMarkAttended(db, body);
      case "reset-feedback":      return await handleResetFeedback(db, body);
      case "admin-list-users":    return await handleAdminListUsers(db);
      case "admin-create-user":   return await handleAdminCreateUser(db, body, caller!);
      case "admin-update-user":   return await handleAdminUpdateUser(db, body, caller!);
      case "admin-delete-user":   return await handleAdminDeleteUser(db, body, caller!);
      case "admin-send-reset":    return await handleAdminSendReset(db, body);
      default:                    return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("unhandled error", action, err);
    return json({ error: "Something went wrong" }, 500);
  }
});
