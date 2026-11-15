import { db } from '../config/db';
import { ensureRolesTables } from './rolesTables';

/*
  Makes sure the database has the table behind Profile and settings, even when
  `prisma db push` has not run against the live database. The SQL matches the
  StudentSettings model in prisma/schema.prisma and is safe to run again: it only
  adds what is missing. If you edit that model, edit this SQL too.
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
];

let ready: Promise<void> | null = null;

export function ensureSettingsTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await ensureRolesTables();
      for (const sql of STATEMENTS) await db.$executeRawUnsafe(sql);
    })().catch((error) => {
      ready = null;
      console.error('Could not prepare the settings table:', error);
    });
  }
  return ready;
}
