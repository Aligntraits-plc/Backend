import { db } from '../config/db';

/*
  Makes sure the database has the Community tables, even when `prisma db push`
  has not run against the live database (the deploy step ignores its errors).

  The SQL is what Prisma itself generates for the Community models in
  prisma/schema.prisma, written so it is safe to run again: it only adds what is
  missing and never changes or drops anything. A later `prisma db push` finds
  nothing to change. If you edit those models, edit this SQL too.

  It runs once per server start, the first time Community is used.
*/
const STATEMENTS = [
  `DO $$ BEGIN
    CREATE TYPE "CommunityEventKind" AS ENUM ('LIVE_SESSION', 'WORKSHOP', 'MEETUP', 'DEADLINE', 'EXAM');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `ALTER TYPE "CommunityEventKind" ADD VALUE IF NOT EXISTS 'EXAM'`,
  `DO $$ BEGIN
    CREATE TYPE "CommunityEventFormat" AS ENUM ('ONLINE', 'IN_PERSON');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `DO $$ BEGIN
    CREATE TYPE "CommunityEventStatus" AS ENUM ('SCHEDULED', 'CANCELLED');
  EXCEPTION WHEN duplicate_object THEN NULL;
  END $$`,
  `CREATE TABLE IF NOT EXISTS "community_channels" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "welcome" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_channels_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_memberships" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_memberships_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_messages" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "fromStaff" BOOLEAN NOT NULL DEFAULT false,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_messages_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_reactions_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_reports" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolution" TEXT,

    CONSTRAINT "community_reports_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rulesAcceptedAt" TIMESTAMP(3),
    "mutedUntil" TIMESTAMP(3),
    "muteReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_profiles_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_team_threads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "studentReadAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "staffReadAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_team_threads_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_team_messages" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "senderId" TEXT,
    "fromStaff" BOOLEAN NOT NULL DEFAULT false,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_team_messages_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_events" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "CommunityEventKind" NOT NULL,
    "format" "CommunityEventFormat" NOT NULL,
    "status" "CommunityEventStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "hostName" TEXT,
    "hostRole" TEXT,
    "summary" TEXT NOT NULL DEFAULT '',
    "agenda" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platform" TEXT,
    "joinUrl" TEXT,
    "venue" TEXT,
    "address" TEXT,
    "mapUrl" TEXT,
    "linkUrl" TEXT,
    "linkLabel" TEXT,
    "recordingUrl" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "community_events_pkey" PRIMARY KEY ("id")
)`,
  `CREATE TABLE IF NOT EXISTS "community_event_reminders" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dayEmailAt" TIMESTAMP(3),
    "hourEmailAt" TIMESTAMP(3),

    CONSTRAINT "community_event_reminders_pkey" PRIMARY KEY ("id")
)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_channels_slug_key" ON "community_channels"("slug")`,
  `CREATE INDEX IF NOT EXISTS "community_memberships_userId_idx" ON "community_memberships"("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_memberships_channelId_userId_key" ON "community_memberships"("channelId", "userId")`,
  `CREATE INDEX IF NOT EXISTS "community_messages_channelId_createdAt_idx" ON "community_messages"("channelId", "createdAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_reactions_messageId_userId_emoji_key" ON "community_reactions"("messageId", "userId", "emoji")`,
  `CREATE INDEX IF NOT EXISTS "community_reports_resolvedAt_idx" ON "community_reports"("resolvedAt")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_reports_messageId_reporterId_key" ON "community_reports"("messageId", "reporterId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_profiles_userId_key" ON "community_profiles"("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_team_threads_userId_key" ON "community_team_threads"("userId")`,
  `CREATE INDEX IF NOT EXISTS "community_team_threads_lastMessageAt_idx" ON "community_team_threads"("lastMessageAt")`,
  `CREATE INDEX IF NOT EXISTS "community_team_messages_threadId_createdAt_idx" ON "community_team_messages"("threadId", "createdAt")`,
  `CREATE INDEX IF NOT EXISTS "community_events_startsAt_idx" ON "community_events"("startsAt")`,
  `CREATE INDEX IF NOT EXISTS "community_event_reminders_userId_idx" ON "community_event_reminders"("userId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "community_event_reminders_eventId_userId_key" ON "community_event_reminders"("eventId", "userId")`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_memberships_channelId_fkey') THEN
      ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "community_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_memberships_userId_fkey') THEN
      ALTER TABLE "community_memberships" ADD CONSTRAINT "community_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_messages_channelId_fkey') THEN
      ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "community_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_messages_userId_fkey') THEN
      ALTER TABLE "community_messages" ADD CONSTRAINT "community_messages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_reactions_messageId_fkey') THEN
      ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "community_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_reactions_userId_fkey') THEN
      ALTER TABLE "community_reactions" ADD CONSTRAINT "community_reactions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_reports_messageId_fkey') THEN
      ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "community_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_reports_reporterId_fkey') THEN
      ALTER TABLE "community_reports" ADD CONSTRAINT "community_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_profiles_userId_fkey') THEN
      ALTER TABLE "community_profiles" ADD CONSTRAINT "community_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_team_threads_userId_fkey') THEN
      ALTER TABLE "community_team_threads" ADD CONSTRAINT "community_team_threads_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_team_messages_threadId_fkey') THEN
      ALTER TABLE "community_team_messages" ADD CONSTRAINT "community_team_messages_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "community_team_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_team_messages_senderId_fkey') THEN
      ALTER TABLE "community_team_messages" ADD CONSTRAINT "community_team_messages_senderId_fkey" FOREIGN KEY ("senderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_events_createdById_fkey') THEN
      ALTER TABLE "community_events" ADD CONSTRAINT "community_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_reminders_eventId_fkey') THEN
      ALTER TABLE "community_event_reminders" ADD CONSTRAINT "community_event_reminders_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "community_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'community_event_reminders_userId_fkey') THEN
      ALTER TABLE "community_event_reminders" ADD CONSTRAINT "community_event_reminders_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
  END $$`,
];

let ready: Promise<void> | null = null;

export function ensureCommunityTables(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      for (const sql of STATEMENTS) {
        await db.$executeRawUnsafe(sql);
      }
    })().catch((error) => {
      // Try again next time. If everything already exists, Community still works.
      ready = null;
      console.error('Could not prepare the Community tables:', error);
    });
  }
  return ready;
}
