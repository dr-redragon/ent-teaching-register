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
import { buildCertificatePdf } from "./certificate.ts";
import { emailConfigured, sendEmail } from "./email.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const APP_BASE_URL = (Deno.env.get("APP_BASE_URL") || "https://dr-redragon.github.io/ent-teaching-register").replace(/\/+$/, "");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function service(): SupabaseClient {
  return createClient(
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

const cleanEmail = (v: unknown) => String(v ?? "").trim().toLowerCase();
const cleanText = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);
const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

function feedbackUrl(sessionId: string) {
  return `${APP_BASE_URL}/feedback.html?s=${encodeURIComponent(sessionId)}`;
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

  const { data: session } = await db.from("sessions").select("id,title,session_date").eq("id", sessionId).maybeSingle();
  if (!session) return json({ error: "This sign-in link is not valid any more" }, 404);

  // Resolve the email server-side: a typed address is saved back onto the
  // trainee's roster record (so it's on file next time); a blank one falls back
  // to whatever is already on file. The stored address is never sent to the
  // browser — it only travels as far as the attendee row here, for the
  // certificate. Trainees not on the roster (localTraineeId null) must type one.
  let email = typedEmail;
  try {
    const { data: resolved } = await db.rpc("resolve_trainee_email", {
      p_trainee_id: localTraineeId,
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
  return json({ ok: true, attendee_id: data.id, name: data.name, session_title: session.title });
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

  const { data, error } = await db.from("sessions")
    .insert({ title, session_date: sessionDate, location, local_id: localId })
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
  return json({ ok: true, session, attendees, email_configured: emailConfigured(), feedback_url: feedbackUrl(sessionId) });
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
  const { data: targets, error } = await q;
  if (error) return json({ error: error.message }, 500);

  const url = feedbackUrl(sessionId);
  const dateLabel = new Date(session.session_date + "T00:00:00Z")
    .toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  let sent = 0; const failures: string[] = [];
  for (const t of targets ?? []) {
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
    if (res.ok) sent++; else failures.push(res.error || "unknown");
  }
  return json({ ok: true, sent, considered: targets?.length ?? 0, failures });
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

  const pdf = await buildCertificatePdf({
    name, sessionTitle: title, sessionDate: date, location,
    reference: "PREVIEW", logoUrl: Deno.env.get("CERT_LOGO_URL") || null,
  });
  return new Response(pdf, {
    headers: { ...CORS, "Content-Type": "application/pdf", "Content-Disposition": 'inline; filename="certificate-preview.pdf"' },
  });
}

/* --------------------------------------------------------------------- router */

const ORGANISER_ACTIONS = new Set([
  "create-session", "session-status", "send-certificate", "email-feedback-link", "certificate-preview",
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
  if (ORGANISER_ACTIONS.has(action) && !(await organiserOk(req))) {
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
      default:                    return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error("unhandled error", action, err);
    return json({ error: "Something went wrong" }, 500);
  }
});
