-- One transaction: store the anonymous response AND flip the attendee's gate.
-- The identifier is used only to find the row to flip; it is never written into
-- feedback_responses. Service role only — the client cannot call this directly.

create or replace function public.record_feedback(
  p_session_id uuid,
  p_identifier text,
  p_overall int,
  p_answers jsonb,
  p_comments text
)
returns table (
  status text,
  attendee_id uuid,
  attendee_name text,
  attendee_email text,
  checked_in boolean,
  certificate_sent_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.attendees%rowtype;
  ident text := nullif(btrim(coalesce(p_identifier, '')), '');
begin
  if not exists (select 1 from public.sessions s where s.id = p_session_id) then
    return query select 'unknown_session'::text, null::uuid, null::text, null::text, false, null::timestamptz;
    return;
  end if;

  if ident is not null then
    select * into a
    from public.attendees att
    where att.session_id = p_session_id
      and (att.id::text = ident or lower(att.email) = lower(ident))
    limit 1
    for update;
  end if;

  -- already gave feedback for this session: do not record a second response
  if a.id is not null and a.feedback_completed then
    return query select 'already_submitted'::text, a.id, a.name, a.email,
                        (a.checked_in_at is not null), a.certificate_sent_at;
    return;
  end if;

  insert into public.feedback_responses (session_id, overall_rating, answers, comments)
  values (p_session_id, p_overall, coalesce(p_answers, '{}'::jsonb), nullif(btrim(coalesce(p_comments, '')), ''));

  if a.id is null then
    -- feedback still counts, but there is nobody to gate a certificate for
    return query select 'recorded_unmatched'::text, null::uuid, null::text, null::text, false, null::timestamptz;
    return;
  end if;

  update public.attendees
     set feedback_completed = true
   where id = a.id;

  return query select 'recorded'::text, a.id, a.name, a.email,
                      (a.checked_in_at is not null), a.certificate_sent_at;
end;
$$;

revoke all on function public.record_feedback(uuid, text, int, jsonb, text) from public, anon, authenticated;
