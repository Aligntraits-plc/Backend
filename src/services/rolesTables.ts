import { db } from '../config/db';
import { ensureSchoolCodeTables } from './schoolCodeTables';
import { ensureCommunityTables } from './communityTables';
import { ensureFormsTables } from './formsTables';

/*
  Makes sure the database has what Roles v1 needs (partner schools, invitations,
  ambassadors, private chats, the student dashboard), even when `prisma db push`
  has not run against the live database (the deploy step ignores its errors).

  The SQL matches the models in prisma/schema.prisma and is safe to run again:
  it only adds what is missing and never changes or drops anything.
  If you edit those models, edit this SQL too.

  It runs once per server start.
*/
const fk = (table: string, column: string, target: string, onDelete = 'CASCADE') => `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${table}_${column}_fkey') THEN
      ALTER TABLE "${table}" ADD CONSTRAINT "${table}_${column}_fkey" FOREIGN KEY ("${column}") REFERENCES "${target}"("id") ON DELETE ${onDelete} ON UPDATE CASCADE;
    END IF;
  END $$`;

const STATEMENTS = [
  `ALTER TYPE "Roles" ADD VALUE IF NOT EXISTS 'COUNSELLOR'`,
  `ALTER TYPE "CommunityEventStatus" ADD VALUE IF NOT EXISTS 'DRAFT'`,
  `ALTER TABLE "school_codes" ADD COLUMN IF NOT EXISTS "partnerSchoolId" TEXT`,
  `ALTER TABLE "community_channels" ADD COLUMN IF NOT EXISTS "partnerSchoolId" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_channels_partnerSchoolId_key" ON "community_channels"("partnerSchoolId")`,

  `CREATE TABLE IF NOT EXISTS "partner_schools" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" TEXT,
    "contactEmail" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_schools_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "partner_schools_name_key" ON "partner_schools"("name")`,

  `CREATE TABLE IF NOT EXISTS "partner_school_staff" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_school_staff_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "partner_school_staff_userId_key" ON "partner_school_staff"("userId")`,
  `CREATE INDEX IF NOT EXISTS "partner_school_staff_schoolId_idx" ON "partner_school_staff"("schoolId")`,
  fk('partner_school_staff', 'schoolId', 'partner_schools'),
  fk('partner_school_staff', 'userId', 'User'),

  `CREATE TABLE IF NOT EXISTS "partner_school_students" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'self',
    "classLevel" TEXT,
    "consentAt" TIMESTAMP(3),
    "removedAt" TIMESTAMP(3),
    "reportApprovedAt" TIMESTAMP(3),
    "reportApprovedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_school_students_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "partner_school_students_userId_key" ON "partner_school_students"("userId")`,
  `CREATE INDEX IF NOT EXISTS "partner_school_students_schoolId_idx" ON "partner_school_students"("schoolId")`,
  fk('partner_school_students', 'schoolId', 'partner_schools'),
  fk('partner_school_students', 'userId', 'User'),

  `CREATE TABLE IF NOT EXISTS "partner_school_invites" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "partner_school_invites_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "partner_school_invites_schoolId_email_key" ON "partner_school_invites"("schoolId", "email")`,
  `CREATE INDEX IF NOT EXISTS "partner_school_invites_createdAt_idx" ON "partner_school_invites"("createdAt")`,

  `CREATE TABLE IF NOT EXISTS "school_listing_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "studentName" TEXT NOT NULL,
    "schoolName" TEXT NOT NULL,
    "schoolEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "school_listing_requests_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "school_listing_requests_createdAt_idx" ON "school_listing_requests"("createdAt")`,

  `CREATE TABLE IF NOT EXISTS "school_seat_purchases" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "seats" INTEGER NOT NULL,
    "amount" INTEGER NOT NULL,
    "reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "codeId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    CONSTRAINT "school_seat_purchases_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "school_seat_purchases_reference_key" ON "school_seat_purchases"("reference")`,
  `CREATE INDEX IF NOT EXISTS "school_seat_purchases_schoolId_idx" ON "school_seat_purchases"("schoolId")`,

  `CREATE TABLE IF NOT EXISTS "role_invites" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "partnerSchoolId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    CONSTRAINT "role_invites_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "role_invites_tokenHash_key" ON "role_invites"("tokenHash")`,
  `CREATE INDEX IF NOT EXISTS "role_invites_email_idx" ON "role_invites"("email")`,

  `CREATE TABLE IF NOT EXISTS "ambassador_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ambassador_profiles_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ambassador_profiles_userId_key" ON "ambassador_profiles"("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ambassador_profiles_code_key" ON "ambassador_profiles"("code")`,
  fk('ambassador_profiles', 'userId', 'User'),

  `CREATE TABLE IF NOT EXISTS "ambassador_referrals" (
    "id" TEXT NOT NULL,
    "ambassadorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ambassador_referrals_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ambassador_referrals_userId_key" ON "ambassador_referrals"("userId")`,
  `CREATE INDEX IF NOT EXISTS "ambassador_referrals_ambassadorId_idx" ON "ambassador_referrals"("ambassadorId")`,

  `CREATE TABLE IF NOT EXISTS "ambassador_invites" (
    "id" TEXT NOT NULL,
    "ambassadorId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ambassador_invites_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "ambassador_invites_email_key" ON "ambassador_invites"("email")`,
  `CREATE INDEX IF NOT EXISTS "ambassador_invites_ambassadorId_createdAt_idx" ON "ambassador_invites"("ambassadorId", "createdAt")`,

  `CREATE TABLE IF NOT EXISTS "direct_threads" (
    "id" TEXT NOT NULL,
    "lowId" TEXT NOT NULL,
    "highId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "blockedById" TEXT,
    "reportedById" TEXT,
    "reportedAt" TIMESTAMP(3),
    "reportReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lowReadAt" TIMESTAMP(3),
    "highReadAt" TIMESTAMP(3),
    CONSTRAINT "direct_threads_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "direct_threads_lowId_highId_key" ON "direct_threads"("lowId", "highId")`,
  `CREATE INDEX IF NOT EXISTS "direct_threads_highId_idx" ON "direct_threads"("highId")`,

  `CREATE TABLE IF NOT EXISTS "direct_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "direct_messages_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE INDEX IF NOT EXISTS "direct_messages_threadId_createdAt_idx" ON "direct_messages"("threadId", "createdAt")`,
  fk('direct_messages', 'threadId', 'direct_threads'),

  `CREATE TABLE IF NOT EXISTS "shortlist_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "shortlist_items_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "shortlist_items_userId_courseId_key" ON "shortlist_items"("userId", "courseId")`,
  `CREATE INDEX IF NOT EXISTS "shortlist_items_userId_idx" ON "shortlist_items"("userId")`,

  `CREATE TABLE IF NOT EXISTS "student_applications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "student_applications_pkey" PRIMARY KEY ("id")
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "student_applications_userId_courseId_key" ON "student_applications"("userId", "courseId")`,
  `CREATE INDEX IF NOT EXISTS "student_applications_userId_idx" ON "student_applications"("userId")`,

  `CREATE TABLE IF NOT EXISTS "staff_seen" (
    "userId" TEXT NOT NULL,
    "requestsSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "staff_seen_pkey" PRIMARY KEY ("userId")
  )`,
];

let ready: Promise<void> | null = null;

export function ensureRolesTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // These tables hang off school codes and Community, so those go first.
      await ensureSchoolCodeTables();
      await ensureCommunityTables();
      await ensureFormsTables();
      for (const sql of STATEMENTS) {
        await db.$executeRawUnsafe(sql);
      }
    })().catch((error) => {
      ready = null;
      console.error('Could not prepare the Roles tables:', error);
    });
  }
  return ready;
}
