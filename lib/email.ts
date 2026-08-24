import { Resend } from 'resend';

const CIRCLE_LOGIN = 'https://login.circle.so/sign_in?request_host=bendecidas.circle.so';
const FROM = process.env.RESEND_FROM ?? 'Danna Abbady <hola@manifestadorapersonal.com>';

function subscriptionHtml(name: string, periodEnd: Date) {
  const date = periodEnd.toLocaleDateString('es-MX', {
    day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Mexico_City',
  });
  const firstName = name.split(' ')[0];
  return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<style>
  body{margin:0;padding:0;background:#f5f0eb;font-family:'Georgia',serif}
  .wrap{max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:#1a0a2e;padding:36px 40px;text-align:center}
  .header h1{margin:0;color:#d4a843;font-size:22px;letter-spacing:.04em;font-weight:400}
  .body{padding:40px}
  .body p{color:#2d1f0e;font-size:16px;line-height:1.7;margin:0 0 16px}
  .date-box{background:#faf6ee;border-left:3px solid #d4a843;padding:14px 20px;margin:24px 0;border-radius:0 6px 6px 0}
  .date-box p{margin:0;font-size:15px;color:#5a3e1b}
  .date-box strong{color:#1a0a2e;font-size:17px}
  .btn{display:inline-block;margin-top:28px;padding:15px 32px;background:#d4a843;color:#1a0a2e;text-decoration:none;border-radius:8px;font-size:15px;font-weight:700;letter-spacing:.02em}
  .footer{padding:24px 40px;border-top:1px solid #f0e8d8;text-align:center}
  .footer p{color:#9b8a6a;font-size:13px;margin:0;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><h1>Comunidad Bendecidas</h1></div>
  <div class="body">
    <p>¡Hola, ${escHtml(firstName)}! 🌸</p>
    <p>Tu membresía en la <strong>Comunidad Bendecidas</strong> está activa. Gracias por ser parte de este espacio tan especial.</p>
    <div class="date-box">
      <p>Tu acceso estará vigente hasta:<br/><strong>${escHtml(date)}</strong></p>
    </div>
    <p>Ya puedes ingresar a la comunidad y disfrutar de todo el contenido que Danna tiene preparado para ti.</p>
    <a class="btn" href="${CIRCLE_LOGIN}">Entrar a la comunidad →</a>
  </div>
  <div class="footer">
    <p>Si tienes alguna pregunta, responde a este correo y con gusto te ayudamos.<br/>Con amor, el equipo de Danna Abbady 💛</p>
  </div>
</div>
</body>
</html>`;
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function sendSubscriptionConfirmation(
  email: string,
  name: string | null,
  periodEnd: Date,
): Promise<void> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const displayName = name ?? email.split('@')[0];
  await new Resend(key).emails.send({
    from: FROM,
    to: email,
    subject: '¡Tu membresía está activa! 🌸',
    html: subscriptionHtml(displayName, periodEnd),
  });
}
