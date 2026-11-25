-- ============================================================================
-- Журнал посещаемости Мастеров · СОтворчество
-- Полная схема базы Supabase. Выполнить один раз: SQL Editor → New query → Run.
-- Повторный запуск безопасен (create if not exists / create or replace).
--
-- Как устроено:
--   • Сотрудники входят через Supabase Auth. Первый зарегистрированный
--     становится администратором, остальные ждут одобрения.
--   • Исходная книга Excel и собранный из неё журнал лежат в закрытом
--     хранилище (bucket «journal»), доступном только сотрудникам.
--   • Отметки — это правки ячеек книги: «Лист!B7» → «НП». История правок
--     хранится в cell_events, текущее состояние — в cell_patches.
--   • Все обращения из приложения идут через функции ниже; прямого доступа
--     к таблицам у браузера нет (RLS включён, политик для таблиц нет).
-- ============================================================================

-- ---------- Сотрудники ----------
create table if not exists public.staff_profiles (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  email          text not null default '',
  status         text not null default 'pending' check (status in ('pending','active','blocked')),
  role           text not null default 'user'    check (role in ('user','admin')),
  requested_role text not null default 'user'    check (requested_role in ('user','admin')),
  created_at     timestamptz not null default now()
);
alter table public.staff_profiles enable row level security;

-- ---------- Журнал ----------
create table if not exists public.journal_meta (
  id             int primary key default 1 check (id = 1),
  fingerprint    text,
  import_info    jsonb,
  roster_version int not null default 1,
  updated_at     timestamptz not null default now()
);
insert into public.journal_meta (id) values (1) on conflict do nothing;
alter table public.journal_meta enable row level security;

-- Листы журнала (для управления списками учеников).
create table if not exists public.journal_sheets (
  id        text primary key,          -- имя листа в книге
  grp       text not null,             -- класс («3А») или экзаменационная группа («ОГЭ · Математика»)
  kind      text not null,             -- primary | primarySubject | class | exam
  quarter   text not null,
  daily_id  text,                      -- для предметов началки: дневной лист
  students  jsonb not null default '[]',  -- [{name,row}]
  next_row  int not null               -- первая свободная строка для новых учеников
);
alter table public.journal_sheets enable row level security;

create table if not exists public.cell_patches (
  cell_key   text primary key,
  cell_value text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.cell_patches enable row level security;

create table if not exists public.cell_events (
  id         bigserial primary key,
  op_id      uuid unique,
  cell_key   text not null,
  cell_value text,
  is_deleted boolean not null default false,
  actor      uuid,
  created_at timestamptz not null default now()
);
alter table public.cell_events enable row level security;

create table if not exists public.roster_rows (
  sheet     text not null,
  row       int  not null,
  name      text not null,
  active    boolean not null default true,
  added     boolean not null default false,
  daily_row int,
  primary key (sheet, row)
);
alter table public.roster_rows enable row level security;

create table if not exists public.audit_log (
  id          bigserial primary key,
  action      text not null,
  actor       text not null default '',
  detail      text not null default '',
  occurred_at timestamptz not null default now()
);
alter table public.audit_log enable row level security;

-- ---------- Работа кураторов с родителями ----------
create table if not exists public.curator_cases (
  id             uuid primary key default gen_random_uuid(),
  week_start     date not null,
  kind           text not null,
  group_name     text not null,
  student_name   text not null,
  reason         text not null default '',
  stats          jsonb not null default '{}',
  status         text not null default 'new' check (status in ('new','contacted','no_answer','resolved')),
  contact_method text not null default '',
  note           text not null default '',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz,
  updated_by     text not null default '',
  unique (week_start, kind, group_name, student_name)
);
alter table public.curator_cases enable row level security;

-- ============================================================================
-- Помощники доступа
-- ============================================================================
create or replace function public.staff_status() returns text
language sql stable security definer set search_path = public as $$
  select status from public.staff_profiles where user_id = auth.uid()
$$;

create or replace function public.is_active_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'active' from public.staff_profiles where user_id = auth.uid()), false)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select status = 'active' and role = 'admin' from public.staff_profiles where user_id = auth.uid()), false)
$$;

create or replace function public.current_email() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select email from auth.users where id = auth.uid()), '')
$$;

create or replace function public.write_audit(p_action text, p_detail text) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (action, actor, detail) values (p_action, public.current_email(), coalesce(p_detail, ''))
$$;

-- Новый пользователь: первый становится администратором, остальные ждут одобрения.
create or replace function public.handle_new_staff() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean;
begin
  select not exists (select 1 from public.staff_profiles) into first_user;
  insert into public.staff_profiles (user_id, email, status, role, requested_role)
  values (
    new.id, coalesce(new.email, ''),
    case when first_user then 'active' else 'pending' end,
    case when first_user then 'admin' else 'user' end,
    case when new.raw_user_meta_data->>'requested_role' = 'admin' then 'admin' else 'user' end
  ) on conflict (user_id) do nothing;
  insert into public.audit_log (action, actor, detail)
  values ('registration', coalesce(new.email, ''), case when first_user then 'Первый сотрудник — назначен администратором' else 'Заявка на доступ' end);
  return new;
end $$;

drop trigger if exists on_auth_user_created_staff on auth.users;
create trigger on_auth_user_created_staff after insert on auth.users
  for each row execute function public.handle_new_staff();

-- ============================================================================
-- Функции для приложения
-- ============================================================================
create or replace function public.masters_session_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', status, 'role', role) from public.staff_profiles where user_id = auth.uid()
$$;

create or replace function public.attendance_state() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare m public.journal_meta;
begin
  if not public.is_active_staff() then return null; end if;
  select * into m from public.journal_meta where id = 1;
  return jsonb_build_object(
    'patches', coalesce((select jsonb_object_agg(cell_key, cell_value) from public.cell_patches), '{}'::jsonb),
    'fingerprint', m.fingerprint,
    'importInfo', m.import_info,
    'revision', coalesce((select max(id) from public.cell_events), 0)
  );
end $$;

create or replace function public.attendance_save(operations jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare op jsonb; accepted jsonb := '[]'::jsonb; n int := 0; inserted int;
begin
  if not public.is_active_staff() then return null; end if;
  for op in select * from jsonb_array_elements(operations) loop
    insert into public.cell_events (op_id, cell_key, cell_value, is_deleted, actor)
    values ((op->>'id')::uuid, op->>'key', op->>'value', coalesce((op->>'deleted')::boolean, false), auth.uid())
    on conflict (op_id) do nothing;
    get diagnostics inserted = row_count;
    if inserted > 0 then
      n := n + 1;
      if coalesce((op->>'deleted')::boolean, false) then
        delete from public.cell_patches where cell_key = op->>'key';
      else
        insert into public.cell_patches (cell_key, cell_value, updated_at, updated_by)
        values (op->>'key', op->>'value', now(), auth.uid())
        on conflict (cell_key) do update set cell_value = excluded.cell_value, updated_at = now(), updated_by = auth.uid();
      end if;
    end if;
    accepted := accepted || to_jsonb(op->>'id');
  end loop;
  if n > 0 then perform public.write_audit('mark', 'Изменено отметок: ' || n); end if;
  return jsonb_build_object('accepted', accepted);
end $$;

create or replace function public.attendance_changes(since_id bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_staff() then return null; end if;
  return jsonb_build_object(
    'events', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'cell_key', cell_key, 'cell_value', cell_value, 'is_deleted', is_deleted) order by id)
                        from (select * from public.cell_events where id > since_id order by id limit 5000) e), '[]'::jsonb),
    'revision', coalesce((select max(id) from public.cell_events), 0)
  );
end $$;

-- Загрузка книги администратором: описание листов для управления списками.
create or replace function public.journal_import(meta jsonb, sheets jsonb, clear_marks boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Загружать книгу может только администратор'; end if;
  delete from public.journal_sheets where id is not null;  -- Supabase запрещает DELETE без WHERE
  insert into public.journal_sheets (id, grp, kind, quarter, daily_id, students, next_row)
  select s->>'id', s->>'grp', s->>'kind', s->>'quarter', s->>'daily_id', coalesce(s->'students', '[]'::jsonb), (s->>'next_row')::int
  from jsonb_array_elements(sheets) s;
  if clear_marks then
    delete from public.cell_patches where cell_key is not null;
    delete from public.roster_rows where sheet is not null;
  end if;
  update public.journal_meta
     set fingerprint = meta->>'fingerprint', import_info = meta, roster_version = roster_version + 1, updated_at = now()
   where id = 1;
  perform public.write_audit('legacy', 'Загружена книга «' || coalesce(meta->>'sourceName', '') || '», листов: ' || jsonb_array_length(sheets));
  return jsonb_build_object('sheets', jsonb_array_length(sheets));
end $$;

-- ---------- Списки учеников ----------
create or replace function public.masters_roster_delta(known_version int) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v int;
begin
  if not public.is_active_staff() then return null; end if;
  select roster_version into v from public.journal_meta where id = 1;
  if v = known_version then return jsonb_build_object('version', v); end if;
  return jsonb_build_object('version', v, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('sheet', sheet, 'row', row, 'name', name, 'active', active, 'added', added, 'dailyRow', daily_row))
    from public.roster_rows), '[]'::jsonb));
end $$;

create or replace function public.masters_roster_list(group_name text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare first_sheet text; result jsonb;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if group_name is null then
    return jsonb_build_object('groups', coalesce((select jsonb_agg(distinct grp) from public.journal_sheets), '[]'::jsonb), 'students', '[]'::jsonb);
  end if;
  select id into first_sheet from public.journal_sheets where grp = group_name
   order by case kind when 'primary' then 0 else 1 end, quarter, id limit 1;
  with base as (
    select st->>'name' as name, (st->>'row')::int as row
    from public.journal_sheets s, jsonb_array_elements(s.students) st where s.id = first_sheet
  ), edits as (
    select * from public.roster_rows where sheet = first_sheet
  )
  select jsonb_agg(jsonb_build_object('name', name, 'active', active) order by name) into result from (
    select b.name, coalesce(e.active, true) as active from base b left join edits e on e.row = b.row and not e.added
    union all
    select name, active from edits where added
  ) x;
  return jsonb_build_object('groups', coalesce((select jsonb_agg(distinct grp) from public.journal_sheets), '[]'::jsonb), 'students', coalesce(result, '[]'::jsonb));
end $$;

create or replace function public.masters_roster_edit(group_name text, student_name text, task text) returns int
language plpgsql security definer set search_path = public as $$
declare s record; base_row int; existing public.roster_rows; new_row int; affected int := 0; daily_rows jsonb := '{}'::jsonb; clean text := btrim(student_name);
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if task not in ('add','archive','restore') then raise exception 'Неизвестное действие'; end if;
  if clean = '' then raise exception 'Укажите фамилию и имя'; end if;
  -- Дневные листы началки обрабатываем первыми, чтобы предметы знали строку ученика в дневном листе.
  for s in select * from public.journal_sheets where grp = group_name
            order by case kind when 'primary' then 0 else 1 end, id loop
    select (st->>'row')::int into base_row from jsonb_array_elements(s.students) st where st->>'name' = clean limit 1;
    select * into existing from public.roster_rows r where r.sheet = s.id and r.name = clean order by r.row limit 1;
    if task = 'add' then
      if existing.sheet is not null then
        update public.roster_rows set active = true where sheet = s.id and row = existing.row;
      elsif base_row is null then
        new_row := greatest(s.next_row, coalesce((select max(row) + 1 from public.roster_rows where sheet = s.id), 0));
        insert into public.roster_rows (sheet, row, name, active, added, daily_row)
        values (s.id, new_row, clean, true, true,
                case when s.kind = 'primarySubject' then (daily_rows->>s.daily_id)::int end);
        if s.kind = 'primary' then daily_rows := daily_rows || jsonb_build_object(s.id, new_row); end if;
      else
        delete from public.roster_rows where sheet = s.id and row = base_row and not added;
      end if;
      affected := affected + 1;
    elsif existing.sheet is not null then
      update public.roster_rows set active = (task = 'restore') where sheet = s.id and row = existing.row;
      affected := affected + 1;
    elsif base_row is not null then
      insert into public.roster_rows (sheet, row, name, active, added)
      values (s.id, base_row, clean, task = 'restore', false)
      on conflict (sheet, row) do update set active = excluded.active;
      affected := affected + 1;
    end if;
  end loop;
  if affected = 0 then raise exception 'Ученик не найден в этой группе'; end if;
  update public.journal_meta set roster_version = roster_version + 1 where id = 1;
  perform public.write_audit(task, clean || ' · ' || group_name);
  return affected;
end $$;

-- ---------- Сотрудники ----------
create or replace function public.masters_account_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', user_id, 'email', email, 'status', status, 'role', role, 'requested_role', requested_role)
                   order by case status when 'pending' then 0 when 'active' then 1 else 2 end, email)
                   from public.staff_profiles), '[]'::jsonb);
end $$;

create or replace function public.masters_account_edit(target_user uuid, new_status text, new_role text) returns boolean
language plpgsql security definer set search_path = public as $$
declare target_email text;
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  if target_user = auth.uid() then raise exception 'Свой доступ изменить нельзя'; end if;
  if new_status not in ('active','blocked','pending') or new_role not in ('user','admin') then raise exception 'Неверные значения'; end if;
  update public.staff_profiles set status = new_status, role = new_role where user_id = target_user returning email into target_email;
  perform public.write_audit('access', coalesce(target_email, '') || ': ' ||
    case new_status when 'active' then 'доступ открыт' when 'blocked' then 'доступ закрыт' else 'ожидает' end ||
    ' · ' || case new_role when 'admin' then 'администратор' else 'пользователь' end);
  return true;
end $$;

create or replace function public.masters_audit_page(before_id bigint, filter_action text, filter_actor text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Нет доступа'; end if;
  return coalesce((select jsonb_agg(to_jsonb(a) order by a.id desc) from (
    select id, action, actor, detail, occurred_at from public.audit_log
    where (before_id is null or id < before_id)
      and (filter_action is null or action = filter_action)
      and (filter_actor is null or actor ilike '%' || filter_actor || '%')
    order by id desc limit 50) a), '[]'::jsonb);
end $$;

-- ---------- Кураторы ----------
create or replace function public.curator_cases_list(since date default null)
returns setof public.curator_cases language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_active_staff() then return; end if;
  return query select * from public.curator_cases
    where since is null or week_start >= since order by week_start desc, group_name, student_name;
end $$;

create or replace function public.curator_cases_add(cases jsonb)
returns setof public.curator_cases language plpgsql security definer set search_path = public as $$
begin
  if not public.is_active_staff() then return; end if;
  return query
    insert into public.curator_cases (week_start, kind, group_name, student_name, reason, stats)
    select (c->>'week_start')::date, c->>'kind', c->>'group_name', c->>'student_name',
           coalesce(c->>'reason', ''), coalesce(c->'stats', '{}'::jsonb)
    from jsonb_array_elements(cases) c
    where (c->>'week_start')::date < date_trunc('week', now())::date
    on conflict (week_start, kind, group_name, student_name) do nothing
    returning *;
end $$;

create or replace function public.curator_case_update(case_id uuid, status text, contact_method text, note text)
returns public.curator_cases language plpgsql security definer set search_path = public as $$
declare result public.curator_cases;
begin
  if not public.is_active_staff() then raise exception 'Нет доступа'; end if;
  if curator_case_update.status not in ('new','contacted','no_answer','resolved') then raise exception 'Неверный статус'; end if;
  update public.curator_cases c
     set status = curator_case_update.status,
         contact_method = left(coalesce(curator_case_update.contact_method, ''), 40),
         note = left(coalesce(curator_case_update.note, ''), 1000),
         updated_at = now(), updated_by = public.current_email()
   where c.id = case_id returning * into result;
  if result.id is null then raise exception 'Запись не найдена'; end if;
  return result;
end $$;

-- ---------- Права на функции ----------
do $$
declare f text;
begin
  foreach f in array array[
    'staff_status()', 'is_active_staff()', 'is_admin()', 'current_email()', 'write_audit(text, text)', 'handle_new_staff()',
    'masters_session_info()', 'attendance_state()', 'attendance_save(jsonb)', 'attendance_changes(bigint)',
    'journal_import(jsonb, jsonb, boolean)', 'masters_roster_delta(int)', 'masters_roster_list(text)',
    'masters_roster_edit(text, text, text)', 'masters_account_list()', 'masters_account_edit(uuid, text, text)',
    'masters_audit_page(bigint, text, text)', 'curator_cases_list(date)', 'curator_cases_add(jsonb)',
    'curator_case_update(uuid, text, text, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon', f);
  end loop;
  foreach f in array array[
    'masters_session_info()', 'attendance_state()', 'attendance_save(jsonb)', 'attendance_changes(bigint)',
    'journal_import(jsonb, jsonb, boolean)', 'masters_roster_delta(int)', 'masters_roster_list(text)',
    'masters_roster_edit(text, text, text)', 'masters_account_list()', 'masters_account_edit(uuid, text, text)',
    'masters_audit_page(bigint, text, text)', 'curator_cases_list(date)', 'curator_cases_add(jsonb)',
    'curator_case_update(uuid, text, text, text)'
  ] loop
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;

-- ============================================================================
-- Хранилище: закрытая папка «journal» для книги Excel и собранного журнала
-- ============================================================================
insert into storage.buckets (id, name, public, file_size_limit)
values ('journal', 'journal', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists "journal read for staff" on storage.objects;
create policy "journal read for staff" on storage.objects for select to authenticated
  using (bucket_id = 'journal' and public.is_active_staff());

drop policy if exists "journal upload for admins" on storage.objects;
create policy "journal upload for admins" on storage.objects for insert to authenticated
  with check (bucket_id = 'journal' and public.is_admin());

drop policy if exists "journal update for admins" on storage.objects;
create policy "journal update for admins" on storage.objects for update to authenticated
  using (bucket_id = 'journal' and public.is_admin()) with check (bucket_id = 'journal' and public.is_admin());

drop policy if exists "journal delete for admins" on storage.objects;
create policy "journal delete for admins" on storage.objects for delete to authenticated
  using (bucket_id = 'journal' and public.is_admin());

-- Хранилищу нужно вызывать проверки доступа.
grant execute on function public.is_active_staff(), public.is_admin() to authenticated;
