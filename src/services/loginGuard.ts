import { db } from '../config/db';

/*
  Five wrong passwords for one email within an hour locks sign in for that email
  until the hour is up. Resetting the password through Forgot password unlocks it.
  Attempts for emails with no account are counted the same way, so the lock never
  reveals whether an account exists. The table is created here if it is missing.
*/
export const MAX_FAILS = 5;
const WINDOW_MS = 60 * 60 * 1000;

let ready: Promise<void> | null = null;
function ensureTable(): Promise<void> {
  if (!ready) {
    ready = db
      .$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "login_attempts" (
          "email" TEXT NOT NULL,
          "fails" INTEGER NOT NULL DEFAULT 0,
          "firstAt" BIGINT NOT NULL,
          "lockedUntil" BIGINT,
          CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("email")
        )`
      )
      .then(() => undefined)
      .catch((error) => {
        ready = null;
        console.error('Could not prepare the login_attempts table:', error);
      });
  }
  return ready;
}

const key = (email: string) => String(email || '').trim().toLowerCase();

// Times are milliseconds since 1970 (UTC), so the server's time zone setting cannot shift them.
type Row = { fails: number; firstAt: number; lockedUntil: number | null };

async function read(email: string): Promise<Row | null> {
  await ensureTable();
  const rows = await db.$queryRawUnsafe<Row[]>(
    `SELECT "fails", "firstAt", "lockedUntil" FROM "login_attempts" WHERE "email" = $1`,
    key(email)
  );
  const r = rows[0];
  return r ? { fails: Number(r.fails), firstAt: Number(r.firstAt), lockedUntil: r.lockedUntil === null ? null : Number(r.lockedUntil) } : null;
}

/** Minutes left on a lock, or 0 when sign in is allowed. */
export async function lockedMinutes(email: string, now = new Date()): Promise<number> {
  try {
    const row = await read(email);
    if (!row?.lockedUntil) return 0;
    const left = row.lockedUntil - now.getTime();
    return left > 0 ? Math.ceil(left / 60000) : 0;
  } catch {
    return 0;
  }
}

/** Records a wrong password. Returns true when this attempt locked the email. */
export async function recordFailure(email: string, now = new Date()): Promise<boolean> {
  try {
    const row = await read(email);
    const t = now.getTime();
    const fresh = !row || t - row.firstAt > WINDOW_MS || (row.lockedUntil !== null && row.lockedUntil <= t);
    const fails = fresh ? 1 : row!.fails + 1;
    const firstAt = fresh ? t : row!.firstAt;
    const lockedUntil = fails >= MAX_FAILS ? t + WINDOW_MS : null;
    await db.$executeRawUnsafe(
      `INSERT INTO "login_attempts" ("email", "fails", "firstAt", "lockedUntil") VALUES ($1, $2, $3, $4)
       ON CONFLICT ("email") DO UPDATE SET "fails" = $2, "firstAt" = $3, "lockedUntil" = $4`,
      key(email),
      fails,
      firstAt,
      lockedUntil
    );
    return !!lockedUntil;
  } catch (error) {
    console.error('Could not record a failed sign in:', error);
    return false;
  }
}

/** Clears the count after a correct password or a password reset. */
export async function clearFailures(email: string): Promise<void> {
  try {
    await ensureTable();
    await db.$executeRawUnsafe(`DELETE FROM "login_attempts" WHERE "email" = $1`, key(email));
  } catch (error) {
    console.error('Could not clear failed sign ins:', error);
  }
}

export const WRONG_DETAILS = 'Incorrect email or password';

export const lockedReply = (minutes: number) => ({
  ok: false,
  status: 429,
  code: 'TOO_MANY_ATTEMPTS',
  message: 'Login failed',
  errors: [
    {
      message: `Too many wrong passwords. Sign in is paused for ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}. Use Forgot password to set a new one now.`,
    },
  ],
});
