-- Fixes "Could not reach the register" on the QR sign-in page and the
-- feedback/certificates link.
--
-- A migration was applied straight to the production database on 1 Sep
-- (20260901141224_require_sign_in_for_all_register_data) that withdrew every
-- anonymous door into the register:
--
--   revoke select  on public.sessions              from anon
--   revoke execute on public.public_roster()       from anon
--   revoke execute on public.record_local_checkin() from anon
--
-- It was never committed here, and the code change that went with it was
-- reverted the same evening ("Restore anonymous QR check-in", dfb0b28) — but
-- only the Edge Function half. The database half stayed, so the repository and
-- the live database have been describing two different systems since.
--
-- The effect on a trainee: checkin.html and feedback.html both open by reading
-- their session row with the publishable key. With no grant, PostgREST refuses
-- the request, ENT.rest() throws, and both pages render their catch-all
-- "Could not reach the register. Check your connection and try again." — which
-- reads as the site being down rather than as a permission being missing.
--
-- This restores the three grants the trainee-facing pages have always needed.

-- Column-level, the same shape as the attendees grant in
-- 20260823120000_feedback_certificates_core.sql: these six columns are what
-- checkin.html, feedback.html and session.html select, and a column added to
-- this table later is not exposed to anon by accident.
grant select (id, title, session_date, location, local_id, form)
  on public.sessions to anon;

-- The name list behind the sign-in dropdown, and the write that mirrors a
-- check-in into the register's own attendance map. Both are SECURITY DEFINER
-- and deliberately narrow — they are the substitute for the direct
-- register_store access anon lost in 20260824055000, not a widening of it.
grant execute on function public.public_roster() to anon;
grant execute on function public.record_local_checkin(text, text, text) to anon;

-- Left as the withdrawn migration set them, on purpose:
--
--   alter default privileges in schema public revoke ... from anon;
--
-- Nothing currently in the schema depends on Supabase's default grants to anon
-- — every migration here grants explicitly — and keeping the defaults closed
-- means a table added later is private until somebody says otherwise. If you add
-- an anon-facing table, grant it in its own migration.
