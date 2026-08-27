-- Someone who signs in with "my name is not on the list" used to exist only as
-- an attendee row: the register reported them at sync time as unmatched and then
-- forgot them, so they were absent from the grid and had to be added by hand
-- before the next teaching day. They now join the roster at the moment they sign
-- in — marked present for this session, and on the list for every future one.
--
-- Called by the check-in Edge Function (service role) only. It is deliberately
-- not granted to anon: appending to the register's trainee list is not something
-- a browser holding the public key should be able to do directly.
create or replace function public.enrol_local_trainee(
  p_name text,
  p_email text,
  p_grade text,
  p_session_id text          -- the register's own session id (sessions.local_id)
)
returns jsonb                -- {"trainee_id": text|null, "created": boolean}
language plpgsql
security definer
set search_path = public
as $$
declare
  name_in    text := btrim(coalesce(p_name, ''));
  email_in   text := nullif(btrim(lower(coalesce(p_email, ''))), '');
  grade_in   text := btrim(coalesce(p_grade, ''));
  session_in text := nullif(btrim(coalesce(p_session_id, '')), '');
  trainee_id text;
  idx        int;
  has_email  boolean;
  created    boolean := false;
begin
  if name_in = '' then
    return jsonb_build_object('trainee_id', null, 'created', false);
  end if;

  -- Two people signing in at the same moment both read-modify-write this one
  -- row; without the lock the second append silently overwrites the first.
  perform 1 from public.register_store where id = 'default' for update;
  if not found then
    -- No register yet: nothing to join. The attendee row still stands.
    return jsonb_build_object('trainee_id', null, 'created', false);
  end if;

  -- A name that is already on the roster (a misread list, a second sign-in from
  -- a new device) attaches to that record rather than creating a duplicate.
  select t->>'id', i, nullif(btrim(coalesce(t->>'email', '')), '') is not null
    into trainee_id, idx, has_email
  from public.register_store,
       lateral jsonb_array_elements(data->'trainees') with ordinality as arr(t, i)
  where id = 'default' and lower(btrim(t->>'name')) = lower(name_in)
  limit 1;

  if trainee_id is null then
    created := true;
    -- Same shape of id the register generates in the browser (7 base-36 chars),
    -- so nothing downstream can tell a self-registered trainee from a typed one.
    trainee_id := substr(md5(random()::text || clock_timestamp()::text), 1, 7);

    update public.register_store
       set data = jsonb_set(
                    coalesce(data, '{}'::jsonb),
                    '{trainees}',
                    coalesce(data->'trainees', '[]'::jsonb) || jsonb_build_array(
                      jsonb_build_object(
                        'id', trainee_id,
                        'name', name_in,
                        'email', coalesce(email_in, ''),
                        'grade', grade_in,
                        -- gradeFrom empty, exactly as a trainee added by hand in
                        -- the register is. The organiser's next load dates the
                        -- grade to this session's month from the attendance
                        -- written below, so a later sign-in supersedes it on the
                        -- same rule as everybody else's.
                        'gradeFrom', ''
                      )
                    ),
                    true
                  ),
           updated_at = now()
     where id = 'default';
  elsif email_in is not null and not has_email then
    -- Already known, but we had no address for them: take the one they typed.
    update public.register_store
       set data = jsonb_set(data, array['trainees', (idx - 1)::text, 'email'], to_jsonb(email_in), true),
           updated_at = now()
     where id = 'default';
  end if;

  -- Mark them present for this teaching day. Unpublished/unlinked sessions have
  -- no local id; the roster entry above still stands, there is just no cell yet.
  if session_in is not null then
    perform public.record_local_checkin(trainee_id, session_in, grade_in);
  end if;

  return jsonb_build_object('trainee_id', trainee_id, 'created', created);
end;
$$;

revoke all on function public.enrol_local_trainee(text, text, text, text) from public, anon, authenticated;
grant execute on function public.enrol_local_trainee(text, text, text, text) to service_role;
-- No grant to anon/authenticated, so no browser can write to the roster with it —
-- only the Edge Function, which sees the sign-in it is acting on.
