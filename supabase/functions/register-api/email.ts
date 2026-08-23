// The only place that talks to an email provider. Swapping Resend for SendGrid,
// Postmark or an institutional SMTP relay means rewriting this file and nothing else.

export interface EmailAttachment {
  filename: string;
  content: Uint8Array;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  ok: boolean;
  id?: string;
  error?: string;
  skipped?: boolean;      // true when email is simply not configured yet
}

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

export function fromAddress(): string {
  const email = Deno.env.get("CERT_FROM_EMAIL") || "onboarding@resend.dev";
  const name = Deno.env.get("CERT_FROM_NAME") || "ENT Regional Teaching";
  return `${name} <${email}>`;
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return { ok: false, skipped: true, error: "email_not_configured" };

  const body: Record<string, unknown> = {
    from: fromAddress(),
    to: [message.to],
    subject: message.subject,
    html: message.html,
  };
  if (message.text) body.text = message.text;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({
      filename: a.filename,
      content: base64(a.content),
    }));
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: payload?.message || payload?.error?.message || `provider_error_${res.status}` };
    }
    return { ok: true, id: payload?.id };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
