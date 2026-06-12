import nodemailer from 'nodemailer';

// Single reusable SMTP transport from env (Hostinger, 465/SSL).
const transport = nodemailer.createTransport({
  host: import.meta.env.SMTP_HOST,
  port: Number(import.meta.env.SMTP_PORT || 465),
  secure: String(import.meta.env.SMTP_SECURE) === 'true',
  auth: {
    user: import.meta.env.SMTP_USER,
    pass: import.meta.env.SMTP_PASS,
  },
});

const FROM = import.meta.env.EMAIL_FROM || 'Viewport <prakash@hiver.com.np>';

export async function sendMail(opts: { to: string; subject: string; html: string; text?: string }) {
  return transport.sendMail({ from: FROM, ...opts });
}

// ---- Branded email templates -------------------------------------------------

const ACCENT = '#84cc16'; // lime accent bar

const shell = (body: string) => `
<div style="margin:0;padding:32px 16px;background:#f3f4f6;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="height:5px;background:${ACCENT}"></div>
    <div style="padding:36px 40px">
      <span style="display:inline-grid;place-items:center;width:40px;height:40px;border-radius:50%;background:${ACCENT};margin-bottom:24px">
        <span style="display:inline-block;width:20px;height:14px;border:2px solid #111;border-radius:3px"></span>
      </span>
      ${body}
    </div>
    <div style="padding:18px 40px;border-top:1px solid #efefef;color:#9ca3af;font-size:12px">
      You received this email because an action was requested for your Viewport account.
    </div>
  </div>
</div>`;

export function otpEmail(code: string, _kind: 'verify' | 'sign-in' | 'reset' = 'verify') {
  const digits = code.split('').join(' ');
  return shell(
    `<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;color:#111">Your Viewport verification code</h1>
     <p style="margin:0 0 6px;color:#374151;font-size:15px;line-height:1.6">Hi there,</p>
     <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6">Use the six-digit code below to verify it's you. It expires in <strong>60 seconds</strong>.</p>
     <div style="border:1px solid #e5e7eb;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
       <div style="font-size:34px;font-weight:700;letter-spacing:10px;color:#111">${digits}</div>
       <div style="margin-top:8px;font-size:11px;font-weight:600;letter-spacing:2px;color:#9ca3af">VERIFICATION CODE</div>
     </div>
     <div style="border-top:1px solid #f0f0f0;padding-top:18px">
       <div style="font-size:11px;font-weight:700;letter-spacing:1.5px;color:#9ca3af;margin-bottom:8px">SECURITY TIPS</div>
       <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.7">• Viewport will never ask for this code by phone or chat.<br/>• Don't share it with anyone.<br/>• If you didn't request this, you can safely ignore this email.</p>
     </div>`
  );
}

export function resetLinkEmail(url: string) {
  return shell(
    `<h1 style="margin:0 0 18px;font-size:24px;font-weight:700;color:#111">Reset your password</h1>
     <p style="margin:0 0 20px;color:#374151;font-size:15px;line-height:1.6">Click the button below to choose a new password. This link expires in 1 hour.</p>
     <a href="${url}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:12px 22px;border-radius:10px">Reset password</a>
     <p style="margin:20px 0 0;color:#9ca3af;font-size:12px;word-break:break-all">Or paste this link: ${url}</p>`
  );
}
