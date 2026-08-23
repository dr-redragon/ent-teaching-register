# Setting up live check-in, feedback and certificates

Everything below is one-off. Once it is done, running a teaching day is:
publish the session, show the QR, share the feedback link, done.

---

## 1. Supabase secrets

Dashboard → **Project Settings → Edge Functions → Secrets** on the
`ent-teaching-register` project. Add these:

| Secret | Required? | What it does |
|---|---|---|
| `ORGANISER_TOKEN` | **yes** | The password that unlocks the organiser side (publishing a session, the attendee list, resending certificates). Invent a long random string. Without it, every organiser action is refused — the function fails closed. |
| `RESEND_API_KEY` | for emails | From [resend.com](https://resend.com) → API Keys. Until it is set, nothing is emailed and certificates report `email_not_configured` rather than failing silently. |
| `CERT_FROM_EMAIL` | no | Sender address. Defaults to `onboarding@resend.dev`. |
| `CERT_FROM_NAME` | no | Sender name. Defaults to `ENT Regional Teaching`. |
| `CERT_LOGO_URL` | no | Direct URL to your logo, **PNG or JPEG** (an SVG must be converted first). |
| `CERT_SIGNATORY_NAME` | no | Adds a signature block to the certificate, e.g. `Mr M Abdelaziz`. |
| `CERT_SIGNATORY_ROLE` | no | The line under it, e.g. `Training Programme Director, ENT North West`. |
| `APP_BASE_URL` | no | Where the pages are published. Defaults to `https://dr-redragon.github.io/ent-teaching-register`. The feedback link inside emails is built from this, so set it if you move the site. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform —
you do not add those.

### About the Resend sandbox

With no verified domain, Resend only delivers to **the email address on your own
Resend account**. That is enough to test the whole flow end to end. To send to
trainees, verify a domain in Resend (a few DNS records), then set
`CERT_FROM_EMAIL` to an address at that domain. No code changes.

### Your logo

Put `logo.png` in the repo (an `assets/` folder is the obvious home), push, and
set `CERT_LOGO_URL` to
`https://dr-redragon.github.io/ent-teaching-register/assets/logo.png`.
It is scaled to fit 150 × 66 pt at the top of the certificate. If the URL ever
breaks, certificates still go out — just without the logo.

---

## 2. Running a teaching day

1. **Publish the session.** Register → *Check-in / QR* → pick the teaching day →
   paste your organiser token (once per device) → set the real date and location
   → **Publish this session**. The QR on that tab now opens the live sign-in page.
2. **On the day**, show the QR. Trainees pick their name, choose their grade,
   type their email, and sign in. Their attendance also lands in the register
   grid; **Pull sign-ins into the register** re-syncs at any point.
3. **At the end**, share the feedback link — the QR and *Copy feedback link* are
   both on that panel, or use **Session console → Email feedback link to everyone
   outstanding** to push it to the addresses people signed in with. You can also
   tick individuals and email only those.
4. **Certificates issue themselves.** Submitting feedback flips the gate and the
   certificate is emailed straight away. The console shows who is still waiting
   and can resend.
5. **Read the feedback** in the console's report: response rate, mean overall,
   the rating spread, a mean per question, and the comments. Print it or take
   the CSV.

---

## 3. What is anonymous, precisely

`feedback_responses` has six columns: `id`, `session_id`, `overall_rating`,
`answers`, `comments`, `submitted_at`. No name, no email, no attendee id, and
**no foreign key to `attendees`**. There is no join that reconstructs who said
what.

The only bridge is the boolean `attendees.feedback_completed`, flipped in the
same transaction as the insert by `record_feedback()`. It records *that* someone
gave feedback, never *what* they said.

Supporting details:

- The report reads `feedback_public`, which exposes the submission **date**
  without a time, so answers cannot be lined up against sign-in times in a small
  cohort.
- Browsers can read only `(id, session_id, name)` of attendees who have already
  checked in — never an email address. Emails are returned only to a caller
  holding the organiser token.
- Browsers cannot read `feedback_responses` at all, and cannot call
  `record_feedback()` directly.
- One response per person per session: a second submission is refused, so the
  gate cannot be used to stuff the results.

Two honest limits: anyone holding the organiser token sees the attendee list and
emails (it is a shared password, not per-user accounts); and free-text comments
are only as anonymous as what people type into them.

### The two linter warnings are deliberate

Supabase's database linter flags `feedback_public` and `session_stats` as
*Security Definer View*. That is the mechanism doing the work, not a mistake:
those views run with the owner's rights precisely so the report can read
aggregates while browsers stay locked out of `feedback_responses` itself. Both
views expose only non-identifying columns. Leaving the warnings is the correct
outcome here; "fixing" them by making the views run as the caller would break
the report or force the raw table open.

---

## 4. If something goes wrong

| Symptom | Cause |
|---|---|
| *Organiser token missing or incorrect* | `ORGANISER_TOKEN` is unset, or the token in your browser does not match. Clear it with `localStorage.removeItem('ent_organiser_token')` and re-enter. |
| Feedback saves, no certificate | Check the console. `Gated` = no feedback yet; `Due` = feedback in, email not sent — usually `RESEND_API_KEY` missing or a send failure. |
| Certificate says `skipped_not_checked_in` | They gave feedback but never signed in on the day. Deliberate: feedback is kept, no certificate. Use **Send now** to override. |
| Emails only reach you | The Resend sandbox sender. Verify a domain (§1). |
| Trainee not in the sync | They typed a name that is not on the roster. The sync names who was skipped; add them to the roster or mark them present by hand. |

Function logs: Supabase dashboard → Edge Functions → `register-api` → Logs.
