-- Журнал работы кураторов с родителями.
-- Выполнить один раз в Supabase: SQL Editor → вставить файл целиком → Run.
--
-- Проверка доступа использует уже существующую функцию masters_session_info():
-- работать с журналом могут только сотрудники со статусом active.
-- Если masters_session_info() возвращает не json/jsonb, поправьте функцию
-- curator_is_active_staff() под вашу таблицу сотрудников.

create table if not exists public.curator_cases (
  id            uuid primary key default gen_random_uuid(),
  week_start    date not null,               -- понедельник недели, за которую ученик попал в список
  kind          text not null,               -- primary | class | exam
  group_name    text not null,               -- класс или экзамен (3А, ОГЭ…)
  student_name  text not null,
  reason        text not null default '',    -- «посещаемость 60% · 2 НП · …»
  stats         jsonb not null default '{}', -- снимок цифр за неделю
  status        text not null default 'new' check (status in ('new','contacted','no_answer','resolved')),
  contact_method text not null default '',
  note          text not null default '',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz,
  updated_by    text not null default '',
  unique (week_start, kind, group_name, student_name)
);

alter table public.curator_cases enable row level security;
-- Прямого доступа к таблице нет: только через функции ниже.

create or replace function public.curator_is_active_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((public.masters_session_info())::jsonb ->> 'status', '') = 'active'
$$;

create or replace function public.curator_cases_list(since date default null)
returns setof public.curator_cases language plpgsql stable security definer set search_path = public as $$
begin
  if not public.curator_is_active_staff() then return; end if;
  return query
    select * from public.curator_cases
    where since is null or week_start >= since
    order by week_start desc, group_name, student_name;
end $$;

-- Добавляет учеников за прошедшую неделю. Повторные вызовы безопасны:
-- уже добавленные (неделя + класс + ученик) пропускаются.
create or replace function public.curator_cases_add(cases jsonb)
returns setof public.curator_cases language plpgsql security definer set search_path = public as $$
begin
  if not public.curator_is_active_staff() then return; end if;
  return query
    insert into public.curator_cases (week_start, kind, group_name, student_name, reason, stats)
    select (c->>'week_start')::date, c->>'kind', c->>'group_name', c->>'student_name',
           coalesce(c->>'reason', ''), coalesce(c->'stats', '{}'::jsonb)
    from jsonb_array_elements(cases) as c
    where (c->>'week_start')::date < date_trunc('week', now())::date  -- только завершённые недели
    on conflict (week_start, kind, group_name, student_name) do nothing
    returning *;
end $$;

create or replace function public.curator_case_update(case_id uuid, status text, contact_method text, note text)
returns public.curator_cases language plpgsql security definer set search_path = public as $$
declare result public.curator_cases;
begin
  if not public.curator_is_active_staff() then
    raise exception 'Нет доступа к журналу кураторов';
  end if;
  update public.curator_cases c
     set status = curator_case_update.status,
         contact_method = left(coalesce(curator_case_update.contact_method, ''), 40),
         note = left(coalesce(curator_case_update.note, ''), 1000),
         updated_at = now(),
         updated_by = coalesce((select email from auth.users where id = auth.uid()), '')
   where c.id = case_id
  returning * into result;
  if result.id is null then raise exception 'Запись не найдена'; end if;
  return result;
end $$;

revoke all on function public.curator_cases_list(date), public.curator_cases_add(jsonb),
  public.curator_case_update(uuid, text, text, text), public.curator_is_active_staff() from public, anon;
grant execute on function public.curator_cases_list(date), public.curator_cases_add(jsonb),
  public.curator_case_update(uuid, text, text, text) to authenticated;
