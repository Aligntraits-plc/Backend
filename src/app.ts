import express from 'express';
import morgan from 'morgan';
import helmet from 'helmet';
import passport from 'passport';

import * as middlewares from './middlewares';
import { originLock } from './middlewares/originLock';
import api from './api';
import MessageResponse from './types/messageResponse';
import { scheduleClearBulkOperationFailuresJob } from './jobs/clearBulkOperationFailuresJob';
import { scheduleCommunityReminderJob } from './jobs/communityReminderJob';

require('dotenv').config();

const app = express();

app.set('trust proxy', true); // Trust ngrok/Render proxies

app.use(morgan('dev'));
app.use(helmet());
// Only aligntraits.com may call the API from a browser (see middlewares/originLock.ts).
app.use(originLock());
app.use(express.json());
app.use(passport.initialize()); // Initialize Passport

// The public /downloads folder was removed. Reports are now sent straight to
// the admin who asked for them (see GET /api/v1/bulk/download).

app.get<{}, MessageResponse>('/', (req, res) => {
  res.status(200).json({
    ok: true,
    message: '🦄🌈✨👋🌎🌍🌏✨🌈🦄',
  });
});

app.use('/api/v1', api);
// Start the cron job when the application starts
scheduleClearBulkOperationFailuresJob();
scheduleCommunityReminderJob();

app.use(middlewares.notFound);
app.use(middlewares.errorHandler);

export default app;
