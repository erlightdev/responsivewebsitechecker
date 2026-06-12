import { PrismaClient } from '@prisma/client';

// Singleton so Astro/Vite dev hot-reloads don't open a new pool each time.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({ log: import.meta.env.PROD ? ['error'] : ['error', 'warn'] });

if (!import.meta.env.PROD) globalForPrisma.prisma = prisma;
