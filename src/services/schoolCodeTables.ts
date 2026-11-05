import { db } from '../config/db';

/*
  Makes sure the database has what school codes need, even when `prisma db push`
  has not run against the live database (the deploy step ignores its errors).

  The SQL is what Prisma itself generates for the SchoolCode and
  SchoolCodeRedemption models and the SCHOOL_PARTNER plan in prisma/schema.prisma,
  written so it is safe to run again: it only adds what is missing and never
  changes or drops anything. A later `prisma db push` finds nothing to change.
  If you edit those models, edit this SQL too.

  It runs once per server start, the first time a school code feature is used.
*/
const STATEMENTS = [
  `ALTER TYPE "PaymentPlan" ADD VALUE IF NOT EXISTS 'SCHOOL_PARTNER'`,
  `CREATE TABLE IF NOT EXISTS "school_codes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "seats" INTEGER NOT NULL DEFAULT 20,
    "used" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "school_codes_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE TABLE IF NOT EXISTS "school_code_redemptions" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "school_code_redemptions_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "school_codes_code_key" ON "school_codes"("code")`,
  `CREATE INDEX IF NOT EXISTS "school_codes_createdAt_idx" ON "school_codes"("createdAt")`,
  `CREATE INDEX IF NOT EXISTS "school_code_redemptions_userId_idx" ON "school_code_redemptions"("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "school_code_redemptions_codeId_userId_key" ON "school_code_redemptions"("codeId", "userId")`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_code_redemptions_codeId_fkey') THEN
      ALTER TABLE "school_code_redemptions" ADD CONSTRAINT "school_code_redemptions_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "school_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'school_code_redemptions_userId_fkey') THEN
      ALTER TABLE "school_code_redemptions" ADD CONSTRAINT "school_code_redemptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
];

let ready: Promise<void> | null = null;

export function ensureSchoolCodeTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const sql of STATEMENTS) {
        await db.$executeRawUnsafe(sql);
      }
    })().catch((error) => {
      // Try again next time. If everything already exists, the feature still works.
      ready = null;
      console.error('Could not prepare the school code tables:', error);
    });
  }
  return ready;
}
