-- Found while adding sessions.form: the sessions table still carried Postgres's
-- default grants to anon and authenticated -- INSERT, UPDATE, DELETE, TRUNCATE,
-- REFERENCES, TRIGGER -- from before RLS was put on it.
--
-- RLS was doing all the work: sessions has exactly one policy (select, to anon),
-- so DML was refused for want of a permissive policy. Two problems with relying
-- on that:
--
--   1. TRUNCATE is not subject to RLS at all. A TRUNCATE grant to anon means the
--      public API key -- which is in this site's own page source -- carried the
--      right to empty the sessions table, cascading to every attendee row and
--      every feedback response.
--   2. The DML grants made the whole table one accidental `for all using (true)`
--      policy away from being writable by anyone.
--
-- Nothing in the browser writes to sessions: checkin.html, feedback.html and
-- session.html only ever select from it, and every write goes through the
-- register-api Edge Function as service_role, which these grants do not affect.

revoke all on public.sessions from anon, authenticated;
grant select on public.sessions to anon, authenticated;

-- Same reasoning for register_store: organisers do write it directly from the
-- register, so it keeps select/insert/update, but nothing needs to be able to
-- drop the entire register in one statement.
revoke delete, truncate, references, trigger on public.register_store from authenticated;
