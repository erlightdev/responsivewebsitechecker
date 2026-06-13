// Invite & earn. A user shares a referral link; when an invited person signs up,
// the referrer earns a fixed store credit (capped at MAX_INVITES paid invites).
// Credit is later spent at checkout as a one-time Dodo discount (see credits.ts).
import { prisma } from '../prisma';

export const CREDIT_PER_INVITE_CENTS = 200; // $2.00 to the referrer per signup
export const WELCOME_CREDIT_CENTS = 200; // $2.00 to the invited (new) account
export const MAX_INVITES = 10; // up to 10 rewarded invites ($20 max)
export const CREDIT_CURRENCY = 'USD';

// A referral code is 8 chars from our unambiguous alphabet; accept 4–16 to be
// lenient about manual entry, but always uppercase + alphanumeric only.
export const REFERRAL_CODE_RE = /^[A-Z0-9]{4,16}$/;

function fmtUsd(cents: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: CREDIT_CURRENCY,
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

// Short, unambiguous code (no 0/O/1/I) derived from a userId + index entropy.
function makeCode(seed: string): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  let out = '';
  for (let i = 0; i < 8; i++) {
    out += alphabet[hash % alphabet.length];
    hash = Math.floor(hash / alphabet.length) + seed.charCodeAt(i % seed.length) * 31;
  }
  return out;
}

/** Ensure the user has a referral code, generating a unique one on first use. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
  if (existing?.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeCode(userId + (attempt ? `-${attempt}` : ''));
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    } catch {
      // unique collision — re-read in case a concurrent request set it, else retry
      const now = await prisma.user.findUnique({ where: { id: userId }, select: { referralCode: true } });
      if (now?.referralCode) return now.referralCode;
    }
  }
  throw new Error('could not allocate referral code');
}

export interface ReferralSummary {
  code: string;
  invitedCount: number;
  maxInvites: number;
  remaining: number;
  perInviteCents: number;
  perInviteAmount: string;
  creditCents: number;
  creditAmount: string;
  invites: Array<{ email: string; date: Date; amount: string }>;
}

/** Everything the invite page needs for the signed-in user. */
export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const code = await ensureReferralCode(userId);
  const [user, referrals] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { creditCents: true } }),
    prisma.referral.findMany({ where: { referrerId: userId }, orderBy: { createdAt: 'desc' } }),
  ]);
  const creditCents = user?.creditCents ?? 0;
  return {
    code,
    invitedCount: referrals.length,
    maxInvites: MAX_INVITES,
    remaining: Math.max(0, MAX_INVITES - referrals.length),
    perInviteCents: CREDIT_PER_INVITE_CENTS,
    perInviteAmount: fmtUsd(CREDIT_PER_INVITE_CENTS),
    creditCents,
    creditAmount: fmtUsd(creditCents),
    invites: referrals.map((r) => ({
      email: maskEmail(r.invitedEmail),
      date: r.createdAt,
      amount: fmtUsd(r.creditCents),
    })),
  };
}

function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!domain) return email;
  const head = name.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

/**
 * Attribute a new signup to a referrer by code and award credit. Idempotent and
 * abuse-guarded: never self-refer, never exceed MAX_INVITES, one credit per
 * invited user (invitedUserId is unique). Best-effort — callers ignore failures.
 */
export interface AttributionResult {
  ok: boolean;
  reason?: 'no_code' | 'bad_code' | 'unknown_code' | 'self' | 'already' | 'cap_reached' | 'error';
  referrerCreditCents?: number;
  welcomeCreditCents?: number;
}

export async function attributeReferral(input: {
  code: string | null | undefined;
  newUserId: string;
  newUserEmail: string;
}): Promise<AttributionResult> {
  // --- validations ---
  const code = (input.code ?? '').trim().toUpperCase();
  if (!code) return { ok: false, reason: 'no_code' };
  if (!REFERRAL_CODE_RE.test(code)) return { ok: false, reason: 'bad_code' };

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, email: true },
  });
  if (!referrer) return { ok: false, reason: 'unknown_code' };
  // Never let an account refer itself (by id or by email).
  if (referrer.id === input.newUserId) return { ok: false, reason: 'self' };
  if (referrer.email.toLowerCase() === input.newUserEmail.toLowerCase()) return { ok: false, reason: 'self' };

  // One attribution per invited account (the signup hook may fire more than once).
  const already = await prisma.referral.findUnique({ where: { invitedUserId: input.newUserId } });
  if (already) return { ok: false, reason: 'already' };

  const count = await prisma.referral.count({ where: { referrerId: referrer.id } });
  if (count >= MAX_INVITES) return { ok: false, reason: 'cap_reached' };

  // --- award: credit BOTH sides ---
  try {
    await prisma.$transaction([
      prisma.referral.create({
        data: {
          referrerId: referrer.id,
          invitedUserId: input.newUserId,
          invitedEmail: input.newUserEmail,
          creditCents: CREDIT_PER_INVITE_CENTS,
        },
      }),
      prisma.user.update({
        where: { id: referrer.id },
        data: { creditCents: { increment: CREDIT_PER_INVITE_CENTS } },
      }),
      // Welcome credit for the newly-invited account.
      prisma.user.update({
        where: { id: input.newUserId },
        data: { creditCents: { increment: WELCOME_CREDIT_CENTS } },
      }),
    ]);
    return {
      ok: true,
      referrerCreditCents: CREDIT_PER_INVITE_CENTS,
      welcomeCreditCents: WELCOME_CREDIT_CENTS,
    };
  } catch {
    return { ok: false, reason: 'error' }; // unique race on invitedUserId
  }
}
