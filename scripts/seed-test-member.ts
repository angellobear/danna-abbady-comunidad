/**
 * Seed completo para un miembro de prueba.
 *
 * Qué hace:
 *   1. Crea (o reutiliza) usuario en Supabase Auth
 *   2. Encuentra o crea el miembro en Circle (Admin API v2)
 *   3. Lo agrega al grupo de suscripción activa
 *   4. Upsert en tabla `members` con el circle_member_id real
 *   5. Verifica token headless de Circle
 *   6. Genera link set-password y lo envía por email (o imprime)
 *
 * Uso:
 *   npx tsx scripts/seed-test-member.ts
 */

import { config } from 'dotenv';
config({ path: '.env.local' });

import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

// Importar funciones del proyecto (usan Admin API v2 + env vars correctas)
import { findOrCreateMember } from '@/lib/circle/members';
import { addToSubscriptionGroup } from '@/lib/circle/access-groups';

// ── Config ────────────────────────────────────────────────────────────────────

const TEST_EMAIL    = 'cruzc51@gmail.com';
const TEST_PASSWORD = 'Test1234!';
const TEST_NAME     = 'Angello Test';
const APP_URL       = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ── Env checks ────────────────────────────────────────────────────────────────

for (const k of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SECRET_KEY', 'CIRCLE_API_KEY', 'CIRCLE_COMMUNITY_ID', 'CIRCLE_ACCESS_GROUP_ID']) {
  if (!process.env[k]) { console.error(`❌ Falta ${k} en .env.local`); process.exit(1); }
}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SECRET_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// ── Email ─────────────────────────────────────────────────────────────────────

function resetEmailHtml(url: string, email: string) {
  const e = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/><style>
    body{font-family:sans-serif;background:#f9f9f9;margin:0}
    .c{max-width:560px;margin:40px auto;background:#fff;border-radius:8px;padding:40px}
    .btn{display:inline-block;margin-top:24px;padding:14px 28px;background:#C8A44A;color:#0E0818;text-decoration:none;border-radius:6px;font-size:15px;font-weight:700}
    .url{margin-top:16px;font-size:12px;color:#666;word-break:break-all}
  </style></head><body><div class="c">
    <p>Configurá tu contraseña para <strong>${e(email)}</strong>.</p>
    <a class="btn" href="${e(url)}">Crear contraseña</a>
    <p class="url">¿No funciona? Copia: ${e(url)}</p>
  </div></body></html>`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  Seed miembro de prueba');
  console.log(`  ${TEST_EMAIL}`);
  console.log('══════════════════════════════════════════\n');

  // 1. Supabase Auth
  console.log('1/6  Supabase Auth...');
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true,
  });
  if (authError && !authError.message.includes('already been registered')) {
    console.error('     ❌', authError.message); process.exit(1);
  }
  console.log(`     ✅ user_id: ${authData?.user?.id ?? '(ya existía)'}`);

  // 2. Circle — findOrCreate
  console.log('\n2/6  Circle — findOrCreate miembro...');
  const circleMember = await findOrCreateMember(TEST_EMAIL, TEST_NAME);
  console.log(`     ✅ circle_member_id: ${circleMember.id}  (${circleMember.name})`);

  // 3. Circle — access group
  console.log('\n3/6  Circle — agregar al grupo de suscripción...');
  await addToSubscriptionGroup(TEST_EMAIL);
  console.log(`     ✅ En grupo ${process.env.CIRCLE_ACCESS_GROUP_ID}`);

  // 4. Supabase DB upsert
  console.log('\n4/6  Supabase DB — upsert members...');
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 1);
  const { error: dbError } = await supabase.from('members').upsert(
    { email: TEST_EMAIL, name: TEST_NAME, status: 'active', circle_member_id: circleMember.id, expires_at: expiresAt.toISOString() },
    { onConflict: 'email' },
  );
  if (dbError) { console.error('     ❌', dbError.message); process.exit(1); }
  console.log(`     ✅ expires_at: ${expiresAt.toISOString().split('T')[0]}`);

  // 5. Link set-password
  console.log('\n5/5  Generar link de contraseña...');
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'recovery', email: TEST_EMAIL,
    options: { redirectTo: `${APP_URL}/set-password` },
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    console.error('     ❌', linkError?.message ?? 'sin token'); process.exit(1);
  }
  const resetUrl = `${APP_URL}/set-password?token_hash=${linkData.properties.hashed_token}&type=recovery`;
  console.log('     ✅ Link generado');

  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    try {
      const { data: sent, error: sendErr } = await new Resend(resendKey).emails.send({
        from: 'Danna Abbady <hola@dannaabbady.com>',
        to: TEST_EMAIL,
        subject: '[TEST] Configurá tu contraseña',
        html: resetEmailHtml(resetUrl, TEST_EMAIL),
      });
      if (sendErr) throw sendErr;
      console.log(`     ✅ Email enviado (id: ${sent?.id})`);
    } catch (err) {
      console.error('     ❌ Email falló:', err);
      console.log('\n     → Link manual:\n    ', resetUrl);
    }
  } else {
    console.log('     ℹ️  RESEND_API_KEY no configurada');
    console.log('\n     → Link manual:\n    ', resetUrl);
  }

  // Resumen
  console.log('\n══════════════════════════════════════════');
  console.log('  ✅ Miembro listo');
  console.log('');
  console.log('  Email:            ', TEST_EMAIL);
  console.log('  Password:         ', TEST_PASSWORD);
  console.log('  circle_member_id: ', circleMember.id);
  console.log('');
  console.log('  Login:   ', `${APP_URL}/login`);
  console.log('  Test UI: ', `${APP_URL}/test`);
  console.log('══════════════════════════════════════════\n');
}

main().catch((err) => { console.error('\n❌ Error inesperado:', err?.response?.data ?? err); process.exit(1); });
