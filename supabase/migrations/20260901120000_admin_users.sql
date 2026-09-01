-- Organiser accounts had no roles: anyone who could sign in could see and change
-- everything, and adding or removing an organiser meant going to the Supabase
-- dashboard. This adds one role — administrator — and the register grows a
-- "Users & access" tab that only administrators can see, so accounts can be
-- managed from the site itself.
--
-- Deliberately narrow: an administrator is a row in this table, nothing more.
-- Every non-admin organiser keeps exactly the access they had before.

create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  -- A convenience copy of the account's address so this table is readable on its
  -- own in the SQL editor. auth.users is the truth; the Edge Function keeps this
  -- in step when an administrator changes someone's email.
  email      text,
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;

-- A signed-in organiser may read exactly one row: their own. That is all the
-- browser needs to decide whether to show the admin tab, and it means the list
-- of who administers the register is not readable by every account.
-- The full list is served by the Edge Function, to administrators only.
drop policy if exists app_admins_read_own on public.app_admins;
create policy app_admins_read_own on public.app_admins
  for select to authenticated using (user_id = auth.uid());

-- No insert/update/delete policy for either role, on purpose: granting and
-- revoking admin happens only through the Edge Function, under the service role,
-- after it has checked that the *caller* is an administrator. A browser holding
-- a signed-in organiser's token cannot make itself one.
revoke all on public.app_admins from anon;
grant select on public.app_admins to authenticated;

-- The first administrator. Everyone else is granted from inside the app.
insert into public.app_admins (user_id, email)
select id, email from auth.users where lower(email) = 'mabdelaziz@outlook.com'
on conflict (user_id) do nothing;
