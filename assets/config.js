/* Shared Supabase configuration for the standalone pages (check-in, feedback,
   organiser console). index.html keeps its own copy of these constants so the
   register still works when opened as a plain file. */
window.ENT = (function () {
  const SUPABASE_URL = 'https://ecyhvubwcqqghumnyxuu.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVjeWh2dWJ3Y3FxZ2h1bW55eHV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NzQ3NzEsImV4cCI6MjA5NzE1MDc3MX0.0aI5Efr6h5UzUY3V-eJz1vihmntIMKqG3-_QMXq4cxY';
  const FUNCTIONS_URL = SUPABASE_URL + '/functions/v1/register-api';

  // Calls the register-api Edge Function. `token` is only needed for organiser actions.
  async function api(action, payload, token) {
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
      'apikey': SUPABASE_ANON_KEY,
    };
    if (token) headers['x-organiser-token'] = token;
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

  // Plain PostgREST read for the anon-readable tables and views.
  async function rest(path) {
    const res = await fetch(SUPABASE_URL + '/rest/v1/' + path, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
    });
    if (!res.ok) throw new Error('Could not load data (' + res.status + ')');
    return await res.json();
  }

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

  return { SUPABASE_URL, SUPABASE_ANON_KEY, FUNCTIONS_URL, api, rest, esc, fmtDate, GRADES, QUESTIONS };
})();
