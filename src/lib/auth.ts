import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { emailOTP, admin } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { defaultStatements, adminAc } from 'better-auth/plugins/admin/access';
import { prisma } from './prisma';
import { sendMail, otpEmail, resetLinkEmail } from './mailer';
import { attributeReferral } from './payments/referrals';

// Access control: "superadmin" gets the full admin permission set; "user" gets none.
const ac = createAccessControl(defaultStatements);
const roles = {
  superadmin: ac.newRole(adminAc.statements),
  user: ac.newRole({}),
};

const SUPERADMIN_EMAIL = (import.meta.env.SUPERADMIN_EMAIL || '').toLowerCase();
const BASE_URL = import.meta.env.BETTER_AUTH_URL || 'http://localhost:4321';

const githubId = import.meta.env.GITHUB_CLIENT_ID;
const githubSecret = import.meta.env.GITHUB_CLIENT_SECRET;
const googleId = import.meta.env.GOOGLE_CLIENT_ID;
const googleSecret = import.meta.env.GOOGLE_CLIENT_SECRET;

// disableImplicitSignUp: a social *sign-in* won't create a new account unless the
// caller explicitly passes requestSignUp:true (the signup page does; login doesn't).
const socialProviders: Record<
  string,
  { clientId: string; clientSecret: string; disableImplicitSignUp: boolean }
> = {};
if (githubId && githubSecret)
  socialProviders.github = { clientId: githubId, clientSecret: githubSecret, disableImplicitSignUp: true };
if (googleId && googleSecret)
  socialProviders.google = { clientId: googleId, clientSecret: googleSecret, disableImplicitSignUp: true };

export const auth = betterAuth({
  baseURL: BASE_URL,
  secret: import.meta.env.BETTER_AUTH_SECRET,
  database: prismaAdapter(prisma, { provider: 'mysql' }),

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url }) => {
      await sendMail({
        to: user.email,
        subject: 'Reset your Viewport password',
        html: resetLinkEmail(url),
      });
    },
  },

  socialProviders,

  user: {
    deleteUser: { enabled: true },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 60, // 60s — drives the "1-min resend / only newest valid" rule
      sendVerificationOnSignUp: true,
      async sendVerificationOTP({ email, otp, type }) {
        await sendMail({
          to: email,
          subject: type === 'sign-in' ? 'Your Viewport sign-in code' : 'Verify your Viewport email',
          html: otpEmail(
            otp,
            type === 'sign-in' ? 'sign-in' : type === 'forget-password' ? 'reset' : 'verify'
          ),
        });
      },
    }),
    admin({
      ac,
      roles,
      defaultRole: 'user',
      adminRoles: ['superadmin'],
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (SUPERADMIN_EMAIL && user.email.toLowerCase() === SUPERADMIN_EMAIL) {
            return { data: { ...user, role: 'superadmin', emailVerified: true } };
          }
          return { data: user };
        },
        // Invite & earn: if the signup carried an invite (vp_ref cookie set when
        // the visitor landed via a referral link), credit the referrer. Best-effort
        // and fully guarded — a failure here must never block account creation.
        after: async (user, ctx) => {
          try {
            const cookie = ctx?.headers?.get('cookie') ?? '';
            const match = cookie.match(/(?:^|;\s*)vp_ref=([^;]+)/);
            const code = match ? decodeURIComponent(match[1]) : null;
            if (code) {
              await attributeReferral({ code, newUserId: user.id, newUserEmail: user.email });
            }
          } catch (err) {
            console.error('[referrals] attribution failed:', err);
          }
        },
      },
    },
  },

  advanced: {
    cookiePrefix: 'vp',
    useSecureCookies: import.meta.env.PROD,
  },
});

export type Session = typeof auth.$Infer.Session;
