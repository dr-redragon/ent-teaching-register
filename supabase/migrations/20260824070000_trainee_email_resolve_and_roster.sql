-- Part of storing a contact email per trainee (not just per sign-in).
--
-- resolve_trainee_email() is called by the check-in Edge Function (service role).
-- It is the one place a trainee's stored email is read or written from the
-- anonymous sign-in path, and it never returns the address to the browser —
-- only the Edge Function sees it, to put on the attendee row for the certificate.
--   * email given  -> save it onto that trainee's register_store record, return it
--   * email blank  -> return the trainee's stored email (or null if none)
create or replace function public.resolve_trainee_email(p_trainee_id text, p_email text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  existing text;
  idx int;
  new_email text := nullif(btrim(coalesce(p_email, '')), '');
begin
  if p_trainee_id is not null then
    select i, (t->>'email')
      into idx, existing
    from public.register_store,
         lateral jsonb_array_elements(data->'trainees') with ordinality as arr(t, i)
    where id = 'default' and t->>'id' = p_trainee_id
    limit 1;
  end if;

  if new_email is not null then
    if idx is not null then
      update public.register_store
         set data = jsonb_set(data, array['trainees', (idx - 1)::text, 'email'], to_jsonb(new_email), true),
             updated_at = now()
       where id = 'default';
    end if;
    return new_email;
  end if;

  return existing;   -- may be null when the trainee has no email on file
end;
$$;

revoke all on function public.resolve_trainee_email(text, text) from public, anon, authenticated;
-- service_role (the Edge Function) can already execute SECURITY DEFINER functions;
-- no grant to anon/authenticated, so a browser cannot read a stored email through it.

-- Roster for the sign-in dropdown now also says, per trainee, whether we already
-- hold an email — a boolean only, so the form can decide whether to require one,
-- without ever exposing the address to an anonymous visitor.
create or replace function public.public_roster()
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
  select jsonb_build_object(
    'trainees', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', t->>'id',
        'name', t->>'name',
        'has_email', (nullif(btrim(coalesce(t->>'email', '')), '') is not null)
      ) order by (t->>'name'))
      from jsonb_array_elements(data->'trainees') t
    ), '[]'::jsonb),
    'sessions', coalesce(data->'sessions', '[]'::jsonb)
  )
  from public.register_store
  where id = 'default'
$$;

revoke all on function public.public_roster() from public;
grant execute on function public.public_roster() to anon, authenticated;
