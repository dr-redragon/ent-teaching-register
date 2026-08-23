-- Reporting surface. Deliberately owner-rights (security_invoker = false) so the
-- report page can read aggregates without any client ever selecting the raw
-- feedback table. Nothing exposed here can identify a respondent: the submitted
-- timestamp is coarsened to a date so answers cannot be lined up against
-- check-in times in a small cohort.

create or replace view public.feedback_public
with (security_invoker = false) as
select
  session_id,
  overall_rating,
  answers,
  comments,
  submitted_at::date as submitted_on
from public.feedback_responses;

comment on view public.feedback_public is
  'Anonymous feedback for reporting. No identifiers exist in the underlying table.';

create or replace view public.session_stats
with (security_invoker = false) as
select
  s.id as session_id,
  s.title,
  s.session_date,
  s.location,
  count(a.id) as attendee_count,
  count(a.id) filter (where a.checked_in_at is not null) as checked_in_count,
  count(a.id) filter (where a.feedback_completed) as feedback_completed_count,
  count(a.id) filter (where a.certificate_sent_at is not null) as certificate_sent_count,
  (select count(*) from public.feedback_responses f where f.session_id = s.id) as response_count,
  (select round(avg(f.overall_rating)::numeric, 2) from public.feedback_responses f where f.session_id = s.id) as avg_overall_rating
from public.sessions s
left join public.attendees a on a.session_id = s.id
group by s.id;

grant select on public.feedback_public to anon;
grant select on public.session_stats to anon;
