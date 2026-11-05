import { NextFunction, Request, Response } from 'express';
import * as community from '../services/communityService';
import * as admin from '../services/communityAdminService';

type Result = { status: number };
type Handler = (req: Request) => Promise<Result>;

// Runs a service and sends its { ok, status, message, data } result.
const handle = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await fn(req);
    res.status(result.status).json(result);
  } catch (error) {
    next(error);
  }
};

const me = (req: Request) => req.user as any;

/* Students */
export const summary = handle((req) => community.communitySummaryService(me(req)));
export const channels = handle((req) => community.listChannelsService(me(req)));
export const acceptRules = handle((req) => community.acceptRulesService(me(req)));
export const joinChannel = handle((req) => community.joinChannelService(me(req), req.params.slug));
export const leaveChannel = handle((req) => community.leaveChannelService(me(req), req.params.slug));
export const channelMessages = handle((req) =>
  community.channelMessagesService(me(req), req.params.slug, {
    before: req.query.before,
    after: req.query.after,
    limit: req.query.limit,
  })
);
export const postChannelMessage = handle((req) =>
  community.postChannelMessageService(me(req), req.params.slug, req.body?.body)
);
export const deleteMessage = handle((req) => community.deleteOwnMessageService(me(req), req.params.id));
export const toggleReaction = handle((req) => community.toggleReactionService(me(req), req.params.id, req.body?.emoji));
export const reportMessage = handle((req) => community.reportMessageService(me(req), req.params.id, req.body?.reason));
export const teamMessages = handle((req) => community.teamMessagesService(me(req), { after: req.query.after }));
export const postTeamMessage = handle((req) => community.postTeamMessageService(me(req), req.body?.body));
export const events = handle((req) => community.listEventsService(me(req), { from: req.query.from, to: req.query.to }));
export const event = handle((req) => community.getEventService(me(req), req.params.id));
export const setReminder = handle((req) => community.setReminderService(me(req), req.params.id, true));
export const removeReminder = handle((req) => community.setReminderService(me(req), req.params.id, false));

/* Admins */
export const adminEvents = handle(() => admin.adminListEventsService());
export const adminCreateEvent = handle((req) => admin.adminCreateEventService(me(req), req.body));
export const adminUpdateEvent = handle((req) => admin.adminUpdateEventService(req.params.id, req.body));
export const adminCancelEvent = handle((req) => admin.adminUpdateEventService(req.params.id, { status: 'CANCELLED' }));
export const adminDeleteEvent = handle((req) => admin.adminDeleteEventService(req.params.id));
export const adminChannels = handle(() => admin.adminListChannelsService());
export const adminUpdateChannel = handle((req) => admin.adminUpdateChannelService(req.params.id, req.body || {}));
export const adminChannelMessages = handle((req) => admin.adminChannelMessagesService(req.params.id, req.query.before));
export const adminPostMessage = handle((req) => admin.adminPostMessageService(me(req), req.params.id, req.body?.body));
export const adminPinMessage = handle((req) => admin.adminPinMessageService(req.params.id, req.body?.pinned));
export const adminDeleteMessage = handle((req) => admin.adminDeleteMessageService(me(req), req.params.id));
export const adminKeepMessage = handle((req) => admin.adminKeepMessageService(me(req), req.params.id));
export const adminReports = handle(() => admin.adminReportsService());
export const adminMuteUser = handle((req) => admin.adminMuteUserService(req.params.userId, req.body?.days, req.body?.reason));
export const adminInbox = handle(() => admin.adminInboxService());
export const adminInboxThread = handle((req) => admin.adminInboxThreadService(req.params.id));
export const adminInboxReply = handle((req) => admin.adminInboxReplyService(me(req), req.params.id, req.body?.body));
