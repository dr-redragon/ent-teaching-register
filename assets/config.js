/* Shared Supabase configuration and helpers for every page. index.html keeps
   its own copy of the two constants, so its data path stands alone, but it
   loads this file too for the idle sign-out clock below — one implementation,
   one stamp, shared by every page that has a login to end. */
window.ENT = (function () {
  const SUPABASE_URL = 'https://ecyhvubwcqqghumnyxuu.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjeWh2dWJ3Y3FxZ2h1bW55eHV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NzQ3NzEsImV4cCI6MjA5NzE1MDc3MX0.0aI5Efr6h5UzUY3V-eJz1vihmntIMKqG3-_QMXq4cxY';
  const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1/register-api';

  // Calls the register-api Edge Function. Organiser actions require the caller's
  // own Supabase Auth access token (from sb.auth.getSession()) as `accessToken` —
  // the Edge Function checks that it belongs to a real signed-in user. Anonymous
  // actions (check-in, submit-feedback) omit it and use the public anon key.
  async function api(action, payload, accessToken) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + (accessToken || SUPABASE_ANON_KEY),
      'apikey': SUPABASE_ANON_KEY,
    };
    const res = await fetch(FUNCTIONS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(Object.assign({ action }, payload || {})),
    });
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/pdf')) return { ok: res.ok, blob: await res.blob() };
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));
    return data;
  }

  // Calls a Postgres RPC function through PostgREST (POST /rest/v1/rpc/<name>).
  // Used for the two narrow, anon-safe functions that stand in for direct
  // register_store access, which now requires an organiser login.
  async function rpc(name, args) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/rpc/' + name, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY,
      },
      body: JSON.stringify(args || {}),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.message || 'Request failed (' + res.status + ')');
    }
    return await res.json();
  }

  // Plain PostgREST read for the anon-readable tables and views. Pass a signed-in
  // organiser's access token to read as `authenticated` instead of `anon` --
  // PostgREST applies the same RLS either way, and this avoids routing a plain
  // read through the Edge Function, which costs a CORS preflight, an isolate
  // boot and an internal auth round trip that PostgREST does not.
  async function rest(path, accessToken) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + (accessToken || SUPABASE_ANON_KEY),
      },
    });
    if (!res.ok) throw new Error('Could not load data (' + res.status + ')');
    return await res.json();
  }

  /* ---------------------------------------------------------------- idle sign-out

     A Supabase session lasts until it is signed out: the refresh token never
     expires on its own, and the server-side "Inactivity timeout" that would end
     it is a paid-plan feature. So the organiser pages keep their own clock. If
     nothing is touched for IDLE_MS, the next check signs this browser out and
     puts the login screen back.

     The stamp lives in localStorage, so every organiser page shares one clock:
     working in the session console keeps the register tab alive, and vice
     versa. Trainee-facing pages never call any of this — they have no login to
     end.

     What it is and isn't: it stops a logged-in browser left on a ward computer
     from still being logged in tomorrow. It is not a security boundary — it
     runs in the page, and the register's own offline copy stays cached in this
     browser either way (that copy can hold changes that never reached the
     database, so signing out must not throw it away). */
  const IDLE_KEY = 'ent-active-since';
  const IDLE_MS = 24 * 60 * 60 * 1000;        // a day
  const IDLE_TICK = 60 * 1000;                // check, and at most write, once a minute

  const idleStamp = () => {
    try { return Number(localStorage.getItem(IDLE_KEY)) || 0; } catch (e) { return 0; }
  };
  const idleClear = () => { try { localStorage.removeItem(IDLE_KEY); } catch (e) {} };

  // Throttled: this runs on every click and keystroke, and a localStorage write
  // per keystroke is both wasteful and a synchronous disk touch.
  function idleTouch(force) {
    const last = idleStamp();
    const now = Date.now();
    if (!force && last && now - last < IDLE_TICK) return;
    try { localStorage.setItem(IDLE_KEY, String(now)); } catch (e) {}
  }

  // No stamp means no clock has been started (a browser that has never signed
  // in, or one signed out cleanly) — that is not an expiry.
  function idleExpired() {
    const last = idleStamp();
    return last > 0 && Date.now() - last > IDLE_MS;
  }

  // Starts the clock for a page that is signed in. onExpire() is called once,
  // and only once, when a whole IDLE_MS has passed without the page being
  // touched. Checked on a timer and again whenever the tab becomes visible,
  // because a hidden tab's timers are throttled and a sleeping laptop's are
  // stopped altogether — coming back to it is when the answer has changed.
  let idleWatching = false;
  function idleWatch(onExpire) {
    if (idleWatching) return;                 // one clock per page, however often this is called
    idleWatching = true;
    idleTouch(true);

    let done = false;
    let timer = 0;
    const check = () => {
      if (done || !idleExpired()) return;
      done = true;
      clearInterval(timer);
      idleClear();
      onExpire();
    };
    const bump = () => { if (!done) idleTouch(false); };

    ['pointerdown', 'keydown'].forEach((type) =>
      document.addEventListener(type, bump, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      check();                                // may already be over the line
      bump();                                 // otherwise, coming back to the tab counts as activity
    });
    timer = setInterval(check, IDLE_TICK);
  }

  const idle = {
    hours: IDLE_MS / (60 * 60 * 1000),
    expired: idleExpired,
    clear: idleClear,
    watch: idleWatch,
    // The one wording, so all three organiser pages say the same thing.
    notice: 'Signed out after ' + (IDLE_MS / (60 * 60 * 1000)) + ' hours without activity. Sign in again to carry on.',
  };

  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso.length === 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  const GRADES = ['ST3','ST4','ST5','ST6','ST7','ST8','Fellow','SAS','Other'];

  /* The feedback question set. Add, remove or reword freely — answers are stored
     as jsonb, so changing this needs no database migration. Keep them 1-5 scales
     if you want them averaged on the report. Old responses keep their old keys;
     the report simply shows whatever keys it finds. */
  const QUESTIONS = [
    { key: 'content',      text: 'The content was relevant to my training' },
    { key: 'delivery',     text: 'The teaching was clear and well delivered' },
    { key: 'organisation', text: 'The day was well organised' },
    { key: 'recommend',    text: 'I would recommend this session to a colleague' },
  ];

  return { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL, api, rest, rpc, idle, esc, fmtDate, GRADES, QUESTIONS };
})();
