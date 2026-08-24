// The only place that talks to an email provider. Swapping Resend for SendGrid,
// Postmark or an institutional SMTP relay means rewriting this file and nothing else.

export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  bcc?: string[];               // used by the bulk chaser, so recipients can't see each other
  replyTo?: string[];           // overrides CERT_REPLY_TO for this one message
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  reason?: EmailFailure;        // machine-readable cause, so the UI can explain it
  skipped?: boolean;            // true when email is simply not configured yet
}

// The failures worth telling the organiser apart. Everything else is "provider".
export type EmailFailure =
  | "not_configured"
  | "sandbox_domain"            // Resend's test sender only reaches your own account
  | "domain_not_verified"
  | "invalid_address"
  | "rate_limited"
  | "provider"
  | "network";

function base64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;                     // avoid blowing the call stack on ~50KB PDFs
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function emailConfigured(): boolean {
  return !!Deno.env.get("RESEND_API_KEY");
}

export function fromEmail(): string {
  return (Deno.env.get("CERT_FROM_EMAIL") || "onboarding@resend.dev").trim();
}

export function fromAddress(): string {
  const name = Deno.env.get("CERT_FROM_NAME") || "ENT Regional Teaching";
  return `${name} <${fromEmail()}>`;
}

// Where trainees' replies should land. This is the one address that can be a
// plain Gmail/NHS mailbox: providers refuse to *send* as a domain you don't
// control, but they will happily point replies at any address you like.
export function replyToAddresses(): string[] {
  return (Deno.env.get("CERT_REPLY_TO") || "")
    .split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

// True while the sender is still Resend's shared test address, which delivers
// ONLY to the Resend account holder. Everyone else silently gets nothing, so it
// is worth saying out loud rather than reporting a generic failure.
export function usingSandboxSender(): boolean {
  return /@resend\.dev$/i.test(fromEmail());
}

function classify(status: number, message: string): EmailFailure {
  const m = message.toLowerCase();
  // Order matters: an unverified real domain also says "verify a domain", so it
  // has to be ruled out before the shared-test-address case.
  if (m.includes("not verified") || m.includes("verify a domain")) return "domain_not_verified";
  if (m.includes("testing emails to your own")) return "sandbox_domain";
  if (m.includes("invalid") && m.includes("email")) return "invalid_address";
  if (status === 429) return "rate_limited";
  return "provider";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Resend's free tier allows 2 requests/second. A teaching day with 30 trainees
// pushed at once used to run straight into 429s and silently drop most of them,
// which looked like "some people just didn't get it". Space the calls out, and
// retry a 429 rather than counting it as a failure.
let nextSlot = 0;
const MIN_GAP_MS = 550;

async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_GAP_MS;
  if (wait) await sleep(wait);
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, skipped: true, reason: "not_configured", error: "email_not_configured" };

  const body: Record<string, unknown> = {
    from: fromAddress(),
    to: [message.to],
    subject: message.subject,
    html: message.html,
  };
  if (message.bcc?.length) body.bcc = message.bcc;
  if (message.text) body.text = message.text;
  const replyTo = message.replyTo?.length ? message.replyTo : replyToAddresses();
  if (replyTo.length) body.reply_to = replyTo;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      filename: a.filename,
      content: base64(a.content),
    }));
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    await throttle();
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json().catch(() => ({}));
      if (res.ok) return { ok: true, id: payload?.id };

      const msg = payload?.message || payload?.error?.message || `provider_error_${res.status}`;
      const reason = classify(res.status, String(msg));
      // A rate limit is worth waiting out; nothing else gets better on a retry.
      if (reason === "rate_limited" && attempt < 2) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      return { ok: false, error: String(msg), reason };
    } catch (err) {
      if (attempt < 2) { await sleep(600 * (attempt + 1)); continue; }
      return { ok: false, error: String(err), reason: "network" };
    }
  }
  return { ok: false, error: "send_failed", reason: "provider" };
}

// One sentence an organiser can act on, for each way a send can fail.
export function explainFailure(reason: EmailFailure | undefined, from = fromEmail()): string {
  switch (reason) {
    case "not_configured":
      return "Email is not configured yet — set RESEND_API_KEY in Supabase → Edge Functions → Secrets.";
    case "sandbox_domain":
      return `Resend is still sending as ${from}, its shared test address, which only delivers to the ` +
             "Resend account holder. Verify your own domain in Resend and set CERT_FROM_EMAIL to an " +
             "address at it — until then trainees receive nothing.";
    case "domain_not_verified":
      return `The domain on ${from} is not verified in Resend yet, so it will not send. ` +
             "Finish the DNS records Resend lists under Domains.";
    case "invalid_address":
      return "That address was rejected as invalid — check it on the Trainees & sessions tab.";
    case "rate_limited":
      return "Resend rate-limited the send even after retrying. Try the remaining people again in a minute.";
    case "network":
      return "Could not reach Resend. Check the connection and try again.";
    default:
      return "The email provider rejected the message.";
  }
}
