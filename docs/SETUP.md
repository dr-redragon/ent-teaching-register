# Setting up live check-in, feedback and certificates

Everything below is one-off. Once it is done, running a teaching day is:
publish the session, show the QR, share the feedback link, done.

---

## 1. Organiser accounts (log in to the register)

The register itself — the attendance grid, excuses, long-term status, trainee
list — is behind a login, and so is everything organiser-only on the other
pages: publishing a session, the session console's attendee list, resending a
certificate. All of it uses this same account; there's nothing separate to set
up for those (no token to paste anywhere) — sign in once on a device and every
page recognises you until you sign out. Trainees checking in or giving
feedback never see any of this; they only ever use `checkin.html` /
`feedback.html`, which don't require an account.

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

### Forgotten passwords

The sign-in screen has a **Forgot password?** link, so organisers no longer
need you to reset it for them from the dashboard. It emails a link (via
Supabase Auth, not the Resend setup below) that brings them back to this same
page to choose a new password.

For that link to work, add the page's own URL to **Supabase dashboard →
Authentication → URL Configuration → Redirect URLs** (the same URL you gave
users in step 3 above, e.g. `https://register.traineehq.com/index.html`).
Without it, Supabase silently drops the redirect and the emailed link sends
people to whatever **Site URL** is set there instead. Supabase's own default
email sending is fine for this — it's rate-limited but no `RESEND_API_KEY` or
verified domain is needed, unlike the certificate/feedback emails below.

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
| `RESEND_API_KEY` | for emails | From [resend.com](https://resend.com) → API Keys. Until it is set, nothing is emailed and certificates report `email_not_configured` rather than failing silently. |
| `CERT_FROM_EMAIL` | **to reach trainees** | Sender address. Must be at a domain you have verified in Resend — see below. Defaults to `onboarding@resend.dev`, which reaches nobody but you. |
| `CERT_FROM_NAME` | no | Sender name. Defaults to `ENT Regional Teaching`. |
| `CERT_REPLY_TO` | no | Where replies go — comma-separated. **This one can be a plain Gmail or NHS address**, because a reply-to is not a sender. Set it to the address you want trainees to reach you on. |
| `CERT_LOGO_URL` | no | Overrides the logo on the certificate. By default it's fetched from `APP_BASE_URL` + `/assets/logo.png` — the copy already in this repo — so you don't need to set this unless you want a different image. **PNG or JPEG** (an SVG must be converted first). |
| `APP_BASE_URL` | no | Where the pages are published. Defaults to `https://register.traineehq.com` (§5). The feedback link inside emails, and the default logo above, are both built from this — set it if you move the site. |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by the platform —
you do not add those.

### Making trainees actually receive their emails

This is the one part of the setup that cannot be done from inside this repo, so
it is worth being precise about.

**Why you can't just send from your Gmail.** No email provider will let you send
mail claiming to be `you@gmail.com` — proving you're allowed to send as a domain
means publishing DNS records on it, and only Google can do that for gmail.com.
Anything that tried would be rejected outright or land in spam. This is not a
Resend limitation; it is how email authentication works everywhere.

**What Resend does out of the box.** With no domain verified, it sends as
`onboarding@resend.dev`, its shared test address, which delivers **only to the
email address on your own Resend account**. Every send still reports success, so
this is exactly the failure mode that looks like it works and reaches nobody.
Both the register's Check-in tab and the session console now say so in as many
words whenever that sender is in use — if you don't see that warning, you're set
up properly.

**The fix, once, about fifteen minutes:**

1. Get a domain if you don't have one. Any registrar; roughly £8–12/year
   (Cloudflare Registrar and Namecheap are both fine). It doesn't need a
   website — you're only using it to send from. Something like
   `nwentteaching.co.uk` works.
2. Resend → **Domains → Add Domain** → type it in.
3. Resend shows three or four DNS records (a TXT for SPF, a TXT for DKIM,
   usually a CNAME or two). Paste each one into your registrar's DNS panel
   exactly as shown.
4. Wait — usually minutes, occasionally a few hours — and press **Verify** in
   Resend until the domain goes green.
5. In Supabase → Edge Functions → Secrets, set `CERT_FROM_EMAIL` to an address
   at that domain, e.g. `certificates@nwentteaching.co.uk`. The mailbox does not
   have to exist; it's a sending identity.
6. Optionally set `CERT_REPLY_TO` to your Gmail, so replies come back to you
   normally.

No code changes and no redeploy — secrets are read on the next call.

**If the domain already has mail on it (iCloud custom email, Google Workspace,
Outlook), nothing above changes — you just don't touch your existing records.**
`traineehq.com` is exactly this case: it already has MX records pointing at
`mx01/mx02.mail.icloud.com` and a root `v=spf1 include:icloud.com ~all` TXT
record for iCloud's own custom-domain mail, and Resend coexists with both
untouched:

- Resend's records land on a `send.traineehq.com` subdomain (its own MX + SPF
  TXT) and on `resend._domainkey.traineehq.com` (its own DKIM selector) — none
  of that is the root domain's MX or SPF, so iCloud mail keeps working exactly
  as before, no changes to it required or wanted.
- `CERT_FROM_EMAIL` can still be a clean root address like
  `no-reply@traineehq.com` even though the technical return-path lives on
  the `send.` subdomain — DMARC passes on DKIM alignment with the root domain,
  which is what Resend signs with. A `no-reply@` sender doesn't need its own
  mailbox; that's exactly what `CERT_REPLY_TO` (§2, above) is for — set it to
  your real address so replies still reach you instead of bouncing.
- Add every record Resend's dashboard shows, verbatim, in Cloudflare (§5's
  panel) — grey-cloud (DNS only) any CNAME among them, since Cloudflare
  proxies new CNAMEs by default and that breaks verification. TXT/MX records
  aren't proxied either way.
- If there's no `_dmarc.traineehq.com` TXT record yet, adding one (Resend
  suggests one, or use `v=DMARC1; p=none;` for monitoring-only) is safe and
  doesn't affect iCloud sending or receiving.

**Volume.** Resend's free tier is 100 emails/day and 3,000/month, at 2 requests
a second. A teaching day of thirty trainees is one feedback push plus thirty
certificates, so a single day fits comfortably; two big days in one calendar day
would not. The rate limit is handled for you — sends are spaced out and a
throttled one is retried rather than being dropped, which is what used to make a
large push quietly reach only the first few people.

### Your logo

`assets/logo.png` is the real North West ENT Regional Trainees Society badge,
already in the repo, and is what certificates use by default — nothing to
configure. To swap it for a different version later, replace that file and
push; if the fetch ever fails for any reason, certificates still go out, just
without the logo.

---

## 3. Running a teaching day

The *Check-in / QR* tab is laid out in the order the day runs: **On the day**
holds the sign-in link, **After the session** opens **Feedback & certificates**
— the console, where everything to do with the feedback form and certificates
lives.

1. **Publish the session.** Register → *Check-in / QR* → pick the teaching day →
   set the real date and location → **Publish this session**. The QR on that
   tab now opens the live sign-in page, and the session starts with a copy of
   the feedback-form template.
2. **On the day**, show the QR. Trainees pick their name, choose their grade,
   and sign in. If we already hold their email (see below) they can leave that
   field blank; if not, they're asked to add one so their certificate can reach
   them. Their attendance also lands in the register grid; **Re-sync sign-ins**
   repairs it at any point, and also backfills any missing roster emails from
   what people signed in with. The icon beside **Open sign-in page** copies the
   link, if you'd rather send it than show the QR.
3. **At the end**, push the feedback form — right there on the *Check-in / QR*
   tab, under **Send the feedback form now**: **Email all outstanding** sends it
   to every checked-in trainee who hasn't given feedback yet, or tick
   individuals and use **Email selected**. **Feedback & certificates** does the
   same and more: the feedback QR, an **Open form** link and a copy icon for
   sharing it another way, **Edit form**, the full attendee list, certificate
   controls and the anonymous report.
4. **Certificates issue themselves.** Submitting feedback flips the gate and the
   certificate is emailed straight away. The attendee list shows who has given
   feedback and whose certificate has gone; the console can resend.
5. **Read the feedback** in the console's report: response rate, mean overall,
   the rating spread, a mean per question, and the comments. Print it or take
   the CSV.

### Editing the feedback form

The questions trainees are asked are no longer fixed. There are two things you
can edit, and the difference matters:

- **The template.** *Check-in / QR* → **Edit the feedback form template** (or
  open `form-editor.html` directly). Every session published from now on starts
  from this. Sessions that already exist are not touched.
- **One session's form.** *Check-in / QR* → pick the day → **Feedback &
  certificates** → **Edit form**, beside the feedback QR. Changes here affect
  that session only. **Save as the template too** does both at once, and **Reset to
  the template** throws the session's own copy away and goes back to inheriting.

The editor works like a form builder: add a question, pick its type (rating 1–5,
multiple choice, checkboxes, short answer, long answer), reorder with ↑/↓,
duplicate, delete, mark it required — with a live preview of what trainees will
see beside it. Two questions are built in and cannot be deleted: the overall 1–5
rating (it is stored in its own column and drives the report) and a free-text
box.

**Why the form is stored per session, not once globally.** Answers are keyed by
question id, and the wording travels with the session. So rewording a question
next year does not silently relabel last year's answers, and a question you
delete still shows its results on the sessions that asked it.

None of this touches anonymity: a form is a set of questions, not an answer.
`feedback_responses` still holds no name, no email and no attendee id.

### Marking someone present without the QR

Ticking a trainee present on the attendance grid, or using the quick
manual sign-in on the *Check-in / QR* tab, now reaches the live session the
same way scanning the QR does. Without this they were invisible to the
feedback form and could never be sent a certificate — only people who used
the QR themselves ever showed up there. If they have no email on file the
push still goes through; they appear on the feedback form and are counted,
but nobody can be sent a certificate for them until an address is added.
Un-ticking someone removes their live check-in the same way, without
touching any feedback or certificate already recorded against them.

This is best effort: if the push cannot reach Supabase (offline, a slow
connection), the register still records it locally and says so — use
**Re-sync sign-ins** on the *Check-in / QR* tab afterwards, which now also
pushes anyone marked present here that never made it through, and reports
by name anyone still missing an email once it has.

### Deleting a session's feedback

The session console has a **Delete feedback** section, marked in red, for
wiping every response recorded for that session and reopening the gate so
it can be collected again — for a session tested with dummy responses, or a
feedback form that needs redoing from scratch. It asks you to confirm, and
states how many responses will be deleted, before anything happens. It does
not touch sign-ins, attendance, or certificates already sent — those stay
sent, so nobody receives a duplicate once feedback is collected again.

### Chasing an unexplained absence

*Check-in / QR* → pick the teaching day → **Unexplained absences**. It lists
every trainee the register counts as eligible for that session who is neither
marked present nor excused — so anyone CCT'd, transferred out, on maternity or
OOP is already excluded, and so is anyone with an excuse recorded.

**Write the chaser email…** opens a composer. Before you send anything it shows
you:

- exactly who it is going to, and that they are all in BCC — no trainee sees
  another trainee's address;
- **who is being left out because we hold no email for them**, by name, so you
  can add those on the *Trainees & sessions* tab and reopen;
- up to four reply-to addresses (a personal Gmail is fine here — a reply-to is
  not a sender), remembered for next time;
- a live preview of the subject, headers and body.

The subject and body are prefilled and fully editable. Nothing is sent until you
press **Send**.

### Trainee grades

A trainee's grade looks after itself: whatever they pick on the sign-in form
becomes their grade in the register, and the newest sign-in always wins. Nothing
to do at the start of a rotation.

To set or correct one by hand — for someone who hasn't signed in yet, or who
picked the wrong thing — use **Edit** on their row on the *Trainees & sessions*
tab. The same dialog edits their name and email. A grade you set by hand sticks
until they sign in again with a different one, at which point the sign-in wins
again.

Past academic years are unaffected by any of this: the attendance grid reads
each year's grade out of that year's sign-ins, so a trainee who was ST4 in
2024/25 still shows ST4 there after they become ST5.

### Long-term status (maternity/paternity, OOP, CCT, transfers)

Set on the *Long-term status* tab, one entry per trainee: CCT, interdeanery
transfer in/out, or a maternity/paternity or out-of-programme leave window
with a start and (usually) an end month.

Maternity/paternity and OOP are the two that come back: once the end month of
the leave has passed, the trainee is automatically shown as Active again and
counts normally in the attendance grid from that point on — nothing to change
by hand, no toggle to flip back. The record of the leave itself is never
deleted; it stays on the *Long-term status* tab, now marked **ended —
counting normally again**, as the history of when it was. CCT and interdeanery
transfers don't behave this way, since they aren't round trips — those keep
showing until you remove or replace them.

A past academic year is unaffected either way: the attendance dashboard,
exports and printed reports show each year's status as it stood by the end of
that year, the same convention used for grades above — so a leave that
genuinely overlapped a past year still shows there even after the trainee has
long since returned.

### Trainee emails

Certificates go to an email address, so the register keeps one per trainee:

- **On the Trainees & sessions tab**, each trainee shows their email (or "no
  email on file"), with an **Email** button to add or change it, and the
  add-trainee form takes an optional email up front.
- **At sign-in**, a trainee we already have an email for can leave the field
  blank; one we don't is required to add it, and it's saved to their record for
  next time. A trainee not on the roster always types one.
- The stored address is never exposed to the anonymous sign-in page — it's
  filled in and read only on the server, and only ever used to send that
  trainee their own certificate.

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
  checked in — never an email address. Emails are returned only to a signed-in
  organiser.
- Browsers cannot read `feedback_responses` at all, and cannot call
  `record_feedback()` directly.
- Browsers have `select` on `sessions` and `form_templates` and nothing else —
  no insert, update, delete or truncate. Every write goes through the Edge
  Function as `service_role`.
- One response per person per session: a second submission is refused, so the
  gate cannot be used to stuff the results.

One honest limit: free-text comments are only as anonymous as what people type
into them — nothing stops a trainee identifying themselves in their own words.

### The two linter warnings are deliberate

Supabase's database linter flags `feedback_public` and `session_stats` as
*Security Definer View*. That is the mechanism doing the work, not a mistake:
those views run with the owner's rights precisely so the report can read
aggregates while browsers stay locked out of `feedback_responses` itself. Both
views expose only non-identifying columns. Leaving the warnings is the correct
outcome here; "fixing" them by making the views run as the caller would break
the report or force the raw table open.

---

## 5. Custom domain (register.traineehq.com)

The register is served by GitHub Pages at **https://register.traineehq.com**,
with DNS held at Cloudflare. `CNAME` in the repository root is the whole of the
GitHub side of that.

**A domain points at a host, never at a path.** `traineehq.com/register` is not
something DNS or a `CNAME` file can express — hence the subdomain. If you ever
do want the apex to lead here, add a Cloudflare redirect rule sending
`traineehq.com/register*` to `register.traineehq.com`; don't try to do it in DNS.

### The DNS record

Cloudflare dashboard → **traineehq.com → DNS → Records → Add record**:

| Field | Value |
|---|---|
| Type | `CNAME` |
| Name | `register` |
| Target | `dr-redragon.github.io` |
| Proxy status | **DNS only** (grey cloud) |
| TTL | Auto |

The target is the *account* host `dr-redragon.github.io` with no path on the
end. GitHub works out which repository to serve from the `CNAME` file, not from
the DNS record — there is nowhere in a DNS record to put a path.

**Leave it grey-clouded.** Proxying (orange cloud) breaks GitHub's certificate
issuance while the domain is being set up, and if Cloudflare's SSL/TLS mode is
`Flexible` it puts the site in an infinite redirect loop, because GitHub Pages
redirects HTTP to HTTPS and Cloudflare keeps answering in plain HTTP. GitHub
Pages already serves through its own CDN with free HTTPS, so the proxy buys
little here. If you do want it on later: set **SSL/TLS → Overview** to `Full`
first, *then* flip the record to proxied.

### The order matters

Do these in order. Step 2 is the point of no return: as soon as GitHub accepts
the custom domain, the old `dr-redragon.github.io/ent-teaching-register/` URL
starts 301-redirecting to `register.traineehq.com`. Do it before the DNS record
exists and the site is unreachable until it does.

1. **Add the Cloudflare record above.** Confirm it resolves before going on:

   ```
   dig +short register.traineehq.com
   ```

   It should print `dr-redragon.github.io`. If it prints nothing, wait and retry
   — don't continue.

2. **Merge to `main`.** That lands `CNAME` at the repository root, and GitHub
   Pages picks the domain up on the next build. Settings → Pages will show
   `register.traineehq.com` with a DNS check against it.

3. **Wait for the certificate.** Settings → Pages reports "provisioning" while
   GitHub gets a Let's Encrypt certificate. Usually minutes, occasionally an
   hour. **Enforce HTTPS** is greyed out until it finishes — tick it as soon as
   it isn't.

4. **Repoint Supabase.** Two places, both in the Supabase dashboard:

   - **Edge Functions → Secrets**: set `APP_BASE_URL` to
     `https://register.traineehq.com`. This is what builds the feedback link
     inside emails and the logo on certificates (§2). The code defaults to this
     value now, so the secret is belt-and-braces — but set it, because an
     explicit secret is what you'll edit next time the address changes.
   - **Authentication → URL Configuration**: set **Site URL** to
     `https://register.traineehq.com/index.html`, and add that same URL to
     **Redirect URLs**. Without it the forgot-password link (§1) silently sends
     organisers somewhere else.

### What doesn't break

Nothing in the pages themselves hardcodes an address — every link, asset and
generated QR code is built relative to whatever URL the page is loaded from. So
the site is correct at the new domain the moment it serves from it, with no code
change.

QR codes and certificate links already handed out with the old
`github.io` address keep working: GitHub redirects them to the new domain. Worth
regenerating session QR codes anyway, so what people scan is one hop shorter.

### While you're in there

You now own a domain, which is what §2 asks for to make certificate emails
reach trainees. Verify `traineehq.com` in Resend and set `CERT_FROM_EMAIL` to
something like `no-reply@traineehq.com`. That is a separate set of DNS
records (SPF, DKIM) in the same Cloudflare panel, and unrelated to the CNAME
above — they coexist fine.

## 6. If something goes wrong

| Symptom | Cause |
|---|---|
| *Please sign in to do this* | Publishing a session or opening the session console needs you to be logged in — the same account as the register. If you already are and still see this, your session may have expired: sign out and back in. |
| Feedback saves, no certificate | Check the console. `Gated` = no feedback yet; `Due` = feedback in, email not sent — usually `RESEND_API_KEY` missing or a send failure. |
| Certificate says `skipped_not_checked_in` | They gave feedback but never signed in on the day. Deliberate: feedback is kept, no certificate. Use **Send now** to override. |
| Emails only reach you | The Resend sandbox sender — `CERT_FROM_EMAIL` is unset or still `@resend.dev`. Verify a domain (§2). The Check-in tab and session console both flag this explicitly. |
| A push says some people failed | The result names each person and the reason — an invalid address, an unverified domain, a rate limit. Fix the address on the Trainees & sessions tab and push again; anyone already emailed is skipped. |
| Trainee not in the sync | They typed a name that is not on the roster. The sync names who was skipped; add them to the roster or mark them present by hand. |
| Can't log in to the register | Confirm the account exists under Authentication → Users and **Auto Confirm User** was ticked. A wrong password shows "Incorrect email or password" — use **Forgot password?** on the sign-in screen, or reset it from the Supabase dashboard (Users → the account → Send password recovery, or set a new one directly). |
| Forgot-password email never arrives | Confirm the page's URL is in Authentication → URL Configuration → Redirect URLs (see §1). Also check spam — Supabase's built-in sender is rate-limited and sometimes filtered. |
| Site unreachable right after the domain switch | The DNS record isn't there (or hasn't propagated) but `CNAME` is already on `main`, so GitHub is redirecting to a name that doesn't resolve. Check `dig +short register.traineehq.com` returns `dr-redragon.github.io`; add the record if it doesn't (§5). |
| Redirect loop / "too many redirects" on the domain | Cloudflare's SSL/TLS mode is `Flexible` with the record proxied. Set **SSL/TLS → Overview** to `Full`, or grey-cloud the record back to DNS only (§5). |
| Settings → Pages stuck on "provisioning" certificate | The record is orange-clouded, so GitHub can't complete its challenge. Switch it to **DNS only** and the certificate issues within minutes (§5). |
| Emailed feedback links point at the old github.io URL | `APP_BASE_URL` still holds the old address, or was never set. Supabase → Edge Functions → Secrets (§5, step 4). Old links still redirect, so this is cosmetic rather than broken. |
| A page sits on "Loading…" and never finishes | Reload once. If it persists, the Supabase library failed to load from the CDN — the page now says so explicitly rather than hanging. Check the connection, or whether a hospital network is blocking `cdn.jsdelivr.net`. |
| Trainee sign-in / feedback page asks for a password | It shouldn't — those never touch login. If it does, you're looking at `index.html` itself rather than `checkin.html` / `feedback.html`; check the link or QR code being used. |

Function logs: Supabase dashboard → Edge Functions → `register-api` → Logs.
