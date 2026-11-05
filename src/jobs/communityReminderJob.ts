import cron from 'node-cron';
import { runCommunityReminders } from '../services/communityMail';

// Every 5 minutes: email students who tapped "Remind me" on an event,
// a day before and an hour before it starts.
// Set COMMUNITY_REMINDERS=off to stop these emails (for example on a test server).
let running = false;

export const scheduleCommunityReminderJob = () => {
  if (process.env.COMMUNITY_REMINDERS === 'off') return;
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const sent = await runCommunityReminders();
      if (sent > 0) console.log(`Community reminders sent: ${sent}`);
    } catch (error) {
      console.error('Community reminder job failed:', error);
    } finally {
      running = false;
    }
  });
};
