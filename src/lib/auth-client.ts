import { createAuthClient } from 'better-auth/client';
import { emailOTPClient, adminClient } from 'better-auth/client/plugins';

export const authClient = createAuthClient({
  baseURL: import.meta.env.PUBLIC_BETTER_AUTH_URL || 'http://localhost:4321',
  plugins: [emailOTPClient(), adminClient()],
});

export const { signIn, signUp, signOut, useSession, emailOtp, admin: adminApi } = authClient;
