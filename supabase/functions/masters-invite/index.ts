// Supabase Edge Function «masters-invite».
// Администратор журнала создаёт персональную ссылку для сотрудника:
//   type: "invite"   — приглашение нового сотрудника (доступ открывается сразу);
//   type: "recovery" — смена забытого пароля для уже зарегистрированного.
// Письма не отправляются: администратор передаёт ссылку лично.
// Секретный ключ берётся из окружения функции и в браузер не попадает.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SITE = 'https://sotvorchestvo.github.io/';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

function serviceKey(): string {
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try {
    const keys = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}');
    return keys.default ?? Object.values(keys)[0] ?? '';
  } catch {
    return '';
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается.' }, 405);
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });

    // Кто вызывает: проверяем токен и что это активный администратор журнала.
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: caller, error: callerError } = await admin.auth.getUser(token);
    if (callerError || !caller?.user) return json({ error: 'Войдите в журнал заново.' }, 401);
    const { data: profile } = await admin.from('staff_profiles').select('status, role, email').eq('user_id', caller.user.id).maybeSingle();
    if (!profile || profile.status !== 'active' || profile.role !== 'admin') {
      return json({ error: 'Создавать ссылки может только администратор.' }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const email = String(body.email ?? '').trim().toLowerCase();
    const type = body.type === 'recovery' ? 'recovery' : 'invite';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: 'Проверьте адрес почты.' }, 400);

    const { data, error } = await admin.auth.admin.generateLink({ type, email, options: { redirectTo: SITE } });
    if (error || !data?.properties?.hashed_token) {
      const message = String(error?.message ?? '');
      if (type === 'invite' && /already|registered|exists/i.test(message)) {
        return json({ error: 'Этот адрес уже зарегистрирован. Если сотрудник забыл пароль, создайте ссылку для смены пароля.' }, 409);
      }
      if (type === 'recovery' && /not found|no user/i.test(message)) {
        return json({ error: 'Сотрудник с такой почтой не найден.' }, 404);
      }
      return json({ error: 'Не удалось создать ссылку. ' + message }, 400);
    }

    // Приглашённый администратором сотрудник получает доступ сразу.
    if (type === 'invite' && data.user?.id) {
      await admin.from('staff_profiles').update({ status: 'active' }).eq('user_id', data.user.id);
    }
    await admin.from('audit_log').insert({
      action: 'invite',
      actor: profile.email ?? '',
      detail: (type === 'invite' ? 'Приглашение для ' : 'Ссылка для смены пароля: ') + email,
    });

    const link = SITE + '#' + (type === 'invite' ? 'invite' : 'reset') + '=' + data.properties.hashed_token;
    return json({ link });
  } catch (error) {
    return json({ error: 'Ошибка сервера: ' + (error instanceof Error ? error.message : String(error)) }, 500);
  }
});
