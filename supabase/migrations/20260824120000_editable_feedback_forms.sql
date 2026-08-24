-- Editable feedback forms.
--
-- Until now the question set was a constant in assets/config.js, identical for
-- every session and only changeable by editing the site. A session now carries
-- its own form, and there is one shared template that new sessions inherit.
--
-- Anonymity is unaffected: a form is a set of questions, not an answer. Answers
-- still land in feedback_responses, which holds no identifier and no foreign key
-- to attendees. Storing the question text alongside the session is in fact what
-- lets the report label old responses correctly after a form is reworded --
-- previously a reworded question silently relabelled every historic answer.

alter table public.sessions
  add column if not exists form jsonb;

comment on column public.sessions.form is
  'The feedback form for this session: {"questions":[{id,type,text,required,options,scale}]}. Null means fall back to the shared template.';

create table if not exists public.form_templates (
  id         text primary key,
  form       jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.form_templates enable row level security;

-- A form is not personal data -- the anonymous feedback page has to be able to
-- read it without an account, exactly as it reads a session's title and date.
-- Writing is service-role only: every edit goes through the organiser-gated
-- Edge Function, never straight from a browser.
revoke all on public.form_templates from anon, authenticated;
grant select on public.form_templates to anon, authenticated;

drop policy if exists form_templates_anon_select on public.form_templates;
create policy form_templates_anon_select on public.form_templates
  for select to anon, authenticated using (true);

-- Seed the default template with the four questions that were hard-coded in
-- assets/config.js, so nothing changes for existing sessions until it is edited.
insert into public.form_templates (id, form)
values ('default', jsonb_build_object(
  'title', 'Session feedback',
  'questions', jsonb_build_array(
    jsonb_build_object('id','overall','type','scale','text','Overall, how would you rate this session?',
                       'required',true,'lowLabel','Poor','highLabel','Excellent','locked',true),
    jsonb_build_object('id','content','type','scale','text','The content was relevant to my training',
                       'required',false,'lowLabel','Strongly disagree','highLabel','Strongly agree'),
    jsonb_build_object('id','delivery','type','scale','text','The teaching was clear and well delivered',
                       'required',false,'lowLabel','Strongly disagree','highLabel','Strongly agree'),
    jsonb_build_object('id','organisation','type','scale','text','The day was well organised',
                       'required',false,'lowLabel','Strongly disagree','highLabel','Strongly agree'),
    jsonb_build_object('id','recommend','type','scale','text','I would recommend this session to a colleague',
                       'required',false,'lowLabel','Strongly disagree','highLabel','Strongly agree'),
    jsonb_build_object('id','comments','type','long','text','Anything else?','required',false,
                       'placeholder','What worked well, what could be better…','locked',true)
  )
))
on conflict (id) do nothing;
