import type { Queryable } from './types.js';
import { UsersRepository } from './usersRepository.js';
import { ConnectionsRepository } from './connectionsRepository.js';
import { PreferencesRepository } from './preferencesRepository.js';
import { DailyBandsRepository } from './dailyBandsRepository.js';
import { DevotionalsRepository } from './devotionalsRepository.js';
import { SessionsRepository } from './sessionsRepository.js';
import { CalendarEventsRepository } from './calendarEventsRepository.js';
import { CandidateSlotsRepository } from './candidateSlotsRepository.js';
import { OAuthStatesRepository } from './oauthStatesRepository.js';
import { GlooEngagementSummariesRepository } from './glooEngagementSummariesRepository.js';
import { PrayerIntentionsRepository } from './prayerIntentionsRepository.js';
import { JournalRepository } from './journalRepository.js';
import { SessionFeedbackRepository } from './sessionFeedbackRepository.js';
import { YouVersionConnectionsRepository } from './youversionConnectionsRepository.js';

export * from './types.js';
export * from './usersRepository.js';
export * from './connectionsRepository.js';
export * from './preferencesRepository.js';
export * from './dailyBandsRepository.js';
export * from './devotionalsRepository.js';
export * from './sessionsRepository.js';
export * from './calendarEventsRepository.js';
export * from './candidateSlotsRepository.js';
export * from './oauthStatesRepository.js';
export * from './glooEngagementSummariesRepository.js';
export * from './prayerIntentionsRepository.js';
export * from './journalRepository.js';
export * from './sessionFeedbackRepository.js';
export * from './youversionConnectionsRepository.js';

/**
 * Repositories are the ONLY code allowed to query users/connections/
 * preferences/daily_bands/devotionals/sessions/calendar_events directly
 * (task requirement, hardening Foundation §10 authz). Route handlers and
 * services must go through this bundle rather than importing `pg`
 * directly or holding their own SQL strings.
 */
export interface Repositories {
  users: UsersRepository;
  connections: ConnectionsRepository;
  preferences: PreferencesRepository;
  dailyBands: DailyBandsRepository;
  devotionals: DevotionalsRepository;
  sessions: SessionsRepository;
  calendarEvents: CalendarEventsRepository;
  candidateSlots: CandidateSlotsRepository;
  oauthStates: OAuthStatesRepository;
  glooEngagementSummaries: GlooEngagementSummariesRepository;
  prayerIntentions: PrayerIntentionsRepository;
  journal: JournalRepository;
  sessionFeedback: SessionFeedbackRepository;
  youversionConnections: YouVersionConnectionsRepository;
}

/** Builds a repository bundle over a pool or an in-flight transaction client. */
export function createRepositories(db: Queryable): Repositories {
  return {
    users: new UsersRepository(db),
    connections: new ConnectionsRepository(db),
    preferences: new PreferencesRepository(db),
    dailyBands: new DailyBandsRepository(db),
    devotionals: new DevotionalsRepository(db),
    sessions: new SessionsRepository(db),
    calendarEvents: new CalendarEventsRepository(db),
    candidateSlots: new CandidateSlotsRepository(db),
    oauthStates: new OAuthStatesRepository(db),
    glooEngagementSummaries: new GlooEngagementSummariesRepository(db),
    prayerIntentions: new PrayerIntentionsRepository(db),
    journal: new JournalRepository(db),
    sessionFeedback: new SessionFeedbackRepository(db),
    youversionConnections: new YouVersionConnectionsRepository(db),
  };
}
