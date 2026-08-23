-- ENT Teaching Register — live check-in, anonymous feedback, gated certificates.
-- Anonymity rule: feedback_responses holds NO identifier and has NO foreign key to
-- attendees beyond session_id. The only bridge is attendees.feedback_completed.

create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  session_date date not null,
  location text,
  local_id text unique,                 -- id of the matching session in the register blob
  created_at timestamptz not null default now()
);

create table if not exists public.attendees (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  name text not null,
  email text not null,
  grade text,
  checked_in_at timestamptz,
  feedback_completed boolean not null default false,
  certificate_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, email)
);

create table if not exists public.feedback_responses (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  overall_rating int check (overall_rating between 1 and 5),
  answers jsonb not null default '{}'::jsonb,
  comments text,
  submitted_at timestamptz not null default now()
);

create index if not exists attendees_session_id_idx on public.attendees(session_id);
create index if not exists feedback_responses_session_id_idx on public.feedback_responses(session_id);

alter table public.sessions enable row level security;
alter table public.attendees enable row level security;
alter table public.feedback_responses enable row level security;

-- sessions: readable by anyone holding the link (title/date/location only, no personal data)
drop policy if exists sessions_anon_select on public.sessions;
create policy sessions_anon_select on public.sessions for select to anon using (true);

-- attendees: anon may read ONLY (id, session_id, name) of people who have checked in,
-- purely so the feedback form can offer a name dropdown. Email is not granted.
revoke all on public.attendees from anon, authenticated;
grant select (id, session_id, name) on public.attendees to anon;
drop policy if exists attendees_anon_select_checked_in on public.attendees;
create policy attendees_anon_select_checked_in on public.attendees
  for select to anon using (checked_in_at is not null);
-- no anon insert/update/delete policies: every write goes through an Edge Function

-- feedback: anon may insert only, never read back
drop policy if exists feedback_anon_insert on public.feedback_responses;
create policy feedback_anon_insert on public.feedback_responses for insert to anon with check (true);
revoke all on public.feedback_responses from anon, authenticated;
grant insert on public.feedback_responses to anon;
