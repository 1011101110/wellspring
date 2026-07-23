/**
 * In-memory fake `AttendeeClient` for tests (H1c, #131) — no network
 * calls, no real bot. Scripted to move through a state sequence so
 * `MeetBotSession` can be exercised against admission delay, a stuck
 * waiting room, and a fatal error without a live attendee.dev account
 * (which doesn't exist yet — see docs/22 §3, H1a spike, issue #129).
 */
import type { AttendeeBotState, AttendeeClient, BotStatus, CreateBotParams, CreateBotResult } from './attendeeClient.js';
import { assertCreateBotModeExclusive } from './attendeeClient.js';

export interface FakeAttendeeClientOptions {
  /**
   * States returned by successive `getBotStatus` calls, in order. The
   * last entry repeats once exhausted. Defaults to an immediate join.
   */
  stateSequence?: AttendeeBotState[];
  botId?: string;
}

export class FakeAttendeeClient implements AttendeeClient {
  readonly createBotCalls: CreateBotParams[] = [];
  readonly leaveCalls: string[] = [];
  readonly deleteDataCalls: string[] = [];
  private statusCallCount = 0;
  private readonly stateSequence: AttendeeBotState[];
  private readonly botId: string;

  constructor(options: FakeAttendeeClientOptions = {}) {
    this.stateSequence = options.stateSequence ?? ['joined_not_recording'];
    this.botId = options.botId ?? 'fake-bot-id';
  }

  async createBot(params: CreateBotParams): Promise<CreateBotResult> {
    // Same boundary check as the real client (#335 mode exclusivity) —
    // a dispatch test that assembles an impossible payload fails here,
    // exactly where production would.
    assertCreateBotModeExclusive(params);
    this.createBotCalls.push(params);
    return { botId: this.botId };
  }

  async getBotStatus(botId: string): Promise<BotStatus> {
    const index = Math.min(this.statusCallCount, this.stateSequence.length - 1);
    this.statusCallCount += 1;
    return { botId, state: this.stateSequence[index]! };
  }

  async requestLeave(botId: string): Promise<void> {
    this.leaveCalls.push(botId);
  }

  async deleteData(botId: string): Promise<void> {
    this.deleteDataCalls.push(botId);
  }
}
