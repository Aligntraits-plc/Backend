import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';

/*
  Makes sure the database has the tables behind Profile and settings, Financing and Workshops, even when
  `prisma db push` has not run against the live database. The SQL matches the
  StudentSettings, Scholarship, ScholarshipFollow and WorkshopInterest models in prisma/schema.prisma and is safe to run again: it only
  adds what is missing. If you edit those models, edit this SQL too.
*/
const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS "student_settings" (
    "userId" TEXT NOT NULL,
    "middleName" TEXT,
    "classLevel" TEXT,
    "classArm" TEXT,
    "stateOfOrigin" TEXT,
    "whatsappSame" BOOLEAN NOT NULL DEFAULT true,
    "guardianName" TEXT,
    "guardianRelation" TEXT,
    "guardianPhone" TEXT,
    "utmeYear" INTEGER,
    "olevelStatus" TEXT,
    "olevelYear" INTEGER,
    "olevelSittings" INTEGER,
    "directEntry" BOOLEAN NOT NULL DEFAULT false,
    "directEntryType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_settings_pkey" PRIMARY KEY ("userId")
  )`,
  `ALTER TABLE "student_settings" ADD COLUMN IF NOT EXISTS "budgetYearly" INTEGER`,
  `ALTER TABLE "student_settings" ADD COLUMN IF NOT EXISTS "budgetCovers" TEXT`,
  `ALTER TABLE "student_settings" ADD COLUMN IF NOT EXISTS "whoPays" TEXT`,
  `ALTER TABLE "student_settings" ADD COLUMN IF NOT EXISTS "wantsNelfund" BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS "scholarships" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "funder" TEXT NOT NULL,
    "amountText" TEXT NOT NULL,
    "windowText" TEXT NOT NULL,
    "closesAt" TIMESTAMP(3),
    "link" TEXT,
    "forText" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'ANY',
    "states" TEXT,
    "arms" TEXT,
    "gender" TEXT,
    "schoolName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "checkedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "scholarships_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "scholarships_slug_key" ON "scholarships"("slug")`,
  `CREATE TABLE IF NOT EXISTS "scholarship_follows" (
    "scholarshipId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentWeek" TIMESTAMP(3),
    "sentDay" TIMESTAMP(3),
    CONSTRAINT "scholarship_follows_pkey" PRIMARY KEY ("scholarshipId", "userId")
  )`,
  `CREATE INDEX IF NOT EXISTS "scholarship_follows_userId_idx" ON "scholarship_follows"("userId")`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scholarship_follows_scholarshipId_fkey') THEN
      ALTER TABLE "scholarship_follows" ADD CONSTRAINT "scholarship_follows_scholarshipId_fkey" FOREIGN KEY ("scholarshipId") REFERENCES "scholarships"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `CREATE TABLE IF NOT EXISTS "workshop_interest" (
    "courseSlug" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "workshop_interest_pkey" PRIMARY KEY ("courseSlug", "userId")
  )`,
];

let ready: Promise<void> | null = null;

export function ensureSettingsTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await ensureRolesTables();
      for (const sql of STATEMENTS) await db.$executeRawUnsafe(sql);
    })().catch((error) => {
      ready = null;
      console.error('Could not prepare the settings tables:', error);
    });
  }
  return ready;
}
