-- sessions had a select policy for `anon` only, from when the only readers were
-- the trainee-facing pages. A signed-in organiser is the `authenticated` role,
-- not `anon`, so reading sessions with their own token returned zero rows -- it
-- happened to work only because the organiser pages were sending the shared anon
-- key instead of the user's token.
--
-- The form editor now reads a session's feedback form straight from PostgREST
-- rather than going through the Edge Function (a CORS preflight, a cold isolate
-- boot and an internal auth round trip cheaper), so organisers need a real read
-- of this table under their own identity.
--
-- Nothing is widened: the same rows were already world-readable to anyone with
-- the anon key. Writes are unaffected -- there is still no insert/update/delete
-- policy on this table for either role, and the grants are select-only.

drop policy if exists sessions_anon_select on public.sessions;
create policy sessions_select on public.sessions
  for select to anon, authenticated using (true);
