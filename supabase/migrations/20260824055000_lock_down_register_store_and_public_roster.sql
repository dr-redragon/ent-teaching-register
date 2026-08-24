-- The register (index.html) is now gated by a real login. register_store held
-- the whole app's data — trainees, attendance, excuses, long-term status — behind
-- RLS policies that granted the "public" role (i.e. anyone, unauthenticated)
-- select/insert/update. That was fine while the only client was the organiser's
-- own browser; it stopped being fine the moment a QR code pointed strangers at
-- this same origin. Restrict it to the authenticated role.

drop policy if exists "public read" on public.register_store;
drop policy if exists "public update" on public.register_store;
drop policy if exists "public write" on public.register_store;

create policy "authenticated read" on public.register_store
  for select to authenticated using (true);
create policy "authenticated update" on public.register_store
  for update to authenticated using (true);
create policy "authenticated write" on public.register_store
  for insert to authenticated with check (true);

revoke all on public.register_store from anon;
grant select, insert, update on public.register_store to authenticated;

-- Anonymous trainees still need two things register_store used to serve
-- directly: the name list for the sign-in dropdown, and a place to mirror a
-- local (unpublished-session) check-in into the register's attendance map.
-- Both are exposed only through these two narrow, purpose-built functions —
-- nothing else about register_store (emails live elsewhere; excuses, status
-- and everyone's full attendance history) is reachable by anon any more.

create or replace function public.public_roster()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'trainees', coalesce(data->'trainees', '[]'::jsonb),
    'sessions', coalesce(data->'sessions', '[]'::jsonb)
  )
  from public.register_store
  where id = 'default'
$$;

revoke all on function public.public_roster() from public;
grant execute on function public.public_roster() to anon, authenticated;

create or replace function public.record_local_checkin(
  p_trainee_id text,
  p_session_id text,
  p_grade text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  k text := p_trainee_id || '|' || p_session_id;
begin
  if p_trainee_id is null or p_session_id is null then
    return;
  end if;
  update public.register_store
     set data = jsonb_set(
                  jsonb_set(
                    coalesce(data, '{}'::jsonb),
                    '{attendance}',
                    coalesce(data->'attendance', '{}'::jsonb)
                  ),
                  array['attendance', k],
                  jsonb_build_object('grade', coalesce(p_grade, '')),
                  true
                ),
         updated_at = now()
   where id = 'default';
end;
$$;

revoke all on function public.record_local_checkin(text, text, text) from public;
grant execute on function public.record_local_checkin(text, text, text) to anon, authenticated;
