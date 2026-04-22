import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var prismaDataEngine: PrismaClient | undefined;
}

export const prisma =
  globalThis.prismaDataEngine ||
  new PrismaClient();

if (process.env.NODE_ENV !== 'production') globalThis.prismaDataEngine = prisma;
