# Setting up live check-in, feedback and certificates

Everything below is one-off. Once it is done, running a teaching day is:
publish the session, show the QR, share the feedback link, done.

---

## 1. Organiser accounts (log in to the register)

The register itself — the attendance grid, excuses, long-term status, trainee
list — is now behind a login. Trainees checking in or giving feedback never see
this; they only ever use `checkin.html` / `feedback.html`, which don't require
an account.

There is no self-service sign-up, by design — you control exactly who can see
the roster. To add someone:

1. Supabase dashboard → **Authentication → Users → Add user**.
2. Enter their email and a password (or send an invite, if you'd rather they
   set their own). Tick **Auto Confirm User** so they can sign in immediately.
3. Give them the URL and that email/password. They sign in from the page
   itself — there's nothing else to configure per person.

Remove access the same way: delete the user from that same list. There's no
separate "roles" concept — anyone with an account sees and can change
everything in the register, same as before this existed, just no longer
open to the world.

### Why this matters, precisely

Before this, `register_store` (the table holding the entire register — every
trainee, every excuse, every status) granted `select`/`insert`/`update` to
`anon`, i.e. anyone holding the public API key, which is visible in this page's
own source. That was fine while the only thing pointed at this project was the
organiser's own browser; it stopped being fine the moment a QR code put that
same origin in front of strangers. It's now restricted to the `authenticated`
role — signing in is what grants it, not knowing the URL.

Trainee-facing pages don't lose anything: a QR sign-in and the kiosk fallback
(the register's own `?form=` link for a session you haven't published yet) both
go through two narrow functions — `public_roster()` (just trainee and session
names, nothing else) and `record_local_checkin()` (writes one attendance entry,
nothing else) — rather than the register itself.

---

## 2. Supabase secrets

Dashboard → **Project Settings → Edge Functions → Secrets** on the
`ent-teaching-register` project. Add these:

| Secret | Required? | What it does |
|---|---|---|
| `ORGANISER_TOKEN` | **yes** | The password that unlocks the organiser side (publishing a session, the attendee list, resending certificates). Invent a long random string. Without it, every organiser action is refused — the function fails closed. |
| `RESEND_API_KEY` | for emails | From [resend.com](https://resend.com) → API Keys. Until it is set, nothing is emailed and certificates report `email_not_configured` rather than failing silently. |
| `CERT_FROM_EMAIL` | no | Sender address. Defaults to `onboarding@resend.dev`. |
| `CERT_FROM_NAME` | no | Sender name. Defaults to `ENT Regional Teaching`. |
| `CERT_LOGO_URL` | no | Overrides the logo on the certificate. By default it's fetched from `APP_BASE_URL` + `/assets/logo.png` — the copy already in this repo — so you don't need to set this unless you want a different image. **PNG or JPEG** (an SVG must be converted first). |
| `APP_BASE_URL` | no | Where the pages are published. Defaults to `https://dr-redragon.github.io/ent-teaching-register`. The feedback link inside emails, and the default logo above, are both built from this — set it if you move the site. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform —
you do not add those.

### About the Resend sandbox

With no verified domain, Resend only delivers to **the email address on your own
Resend account**. That is enough to test the whole flow end to end. To send to
trainees, verify a domain in Resend (a few DNS records), then set
`CERT_FROM_EMAIL` to an address at that domain. No code changes.

### Your logo

`assets/logo.png` is already in the repo and is what certificates use by
default — nothing to configure. It's a hand-drawn recreation of the North West
ENT Regional Trainees Society badge (there's no way for this session to save an
image someone pastes into chat to disk), close in composition and colour but
not a pixel-exact copy. Send the real file and it's a straight swap — replace
`assets/logo.png`, push, done. If the fetch ever fails for any reason,
certificates still go out, just without the logo.

---

## 3. Running a teaching day

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

## 4. What is anonymous, precisely

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

## 5. If something goes wrong

| Symptom | Cause |
|---|---|
| *Organiser token missing or incorrect* | `ORGANISER_TOKEN` is unset, or the token in your browser does not match. Clear it with `localStorage.removeItem('ent_organiser_token')` and re-enter. |
| Feedback saves, no certificate | Check the console. `Gated` = no feedback yet; `Due` = feedback in, email not sent — usually `RESEND_API_KEY` missing or a send failure. |
| Certificate says `skipped_not_checked_in` | They gave feedback but never signed in on the day. Deliberate: feedback is kept, no certificate. Use **Send now** to override. |
| Emails only reach you | The Resend sandbox sender. Verify a domain (§2). |
| Trainee not in the sync | They typed a name that is not on the roster. The sync names who was skipped; add them to the roster or mark them present by hand. |
| Can't log in to the register | Confirm the account exists under Authentication → Users and **Auto Confirm User** was ticked. A wrong password shows "Incorrect email or password" — there's no self-service reset page here, so reset it from the Supabase dashboard (Users → the account → Send password recovery, or set a new one directly). |
| Trainee sign-in / feedback page asks for a password | It shouldn't — those never touch login. If it does, you're looking at `index.html` itself rather than `checkin.html` / `feedback.html`; check the link or QR code being used. |

Function logs: Supabase dashboard → Edge Functions → `register-api` → Logs.
