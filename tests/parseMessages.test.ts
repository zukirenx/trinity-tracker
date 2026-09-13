import { describe, expect, it } from 'vitest';
import { parseMessagesIntoRewards, type DiscordChannelMessage } from '../src/index';
import { formatMalformedWarning, formatStaleWarning } from '../src/utils/rewardParser';

function makeMessage(id: string, content: string, timestamp = '2026-03-15T12:00:00Z'): DiscordChannelMessage {
  return { id, content, timestamp };
}

describe('parseMessagesIntoRewards', () => {
  it('parses a simple train reward', () => {
    const messages = [makeMessage('1', '15.03 PlayerOne')];
    const { rewards, memberNames, parsed, failed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(1);
    expect(failed).toBe(0);
    expect(rewards).toHaveLength(1);
    expect(rewards[0].driverName).toBe('PlayerOne');
    expect(rewards[0].type).toBe('TRAIN');
    expect(rewards[0].vipName).toBeNull();
    expect(memberNames.has('PlayerOne')).toBe(true);
  });

  it('parses a train + VIP reward into two entries', () => {
    const messages = [makeMessage('1', '15.03 Driver + VIPPlayer')];
    const { rewards, memberNames, parsed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(1);
    expect(rewards).toHaveLength(2);
    expect(rewards[0].type).toBe('TRAIN');
    expect(rewards[0].driverName).toBe('Driver');
    expect(rewards[0].vipName).toBeNull();
    expect(rewards[1].type).toBe('VIP');
    expect(rewards[1].vipName).toBe('VIPPlayer');
    expect(memberNames.has('Driver')).toBe(true);
    expect(memberNames.has('VIPPlayer')).toBe(true);
  });

  it('handles multi-line messages', () => {
    const content = '15.03 Alpha\n16.03 Beta + Gamma';
    const messages = [makeMessage('1', content)];
    const { rewards, parsed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(2);
    expect(rewards).toHaveLength(3); // 2 TRAIN + 1 VIP
  });

  it('skips empty messages', () => {
    const messages = [
      makeMessage('1', ''),
      makeMessage('2', '   '),
      makeMessage('3', undefined as unknown as string),
    ];
    const { rewards, parsed, failed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(0);
    expect(failed).toBe(0);
    expect(rewards).toHaveLength(0);
  });

  it('counts unparseable lines as failed', () => {
    const messages = [makeMessage('1', 'not a reward line')];
    const { rewards, parsed, failed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(0);
    expect(failed).toBe(1);
    expect(rewards).toHaveLength(0);
  });

  it('strips trailing parenthetical notes from lines', () => {
    const messages = [makeMessage('1', '15.03 PlayerOne (demo run)')];
    const { rewards, parsed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(1);
    expect(rewards[0].driverName).toBe('PlayerOne');
  });

  it('uses message timestamp as reference date for parsing', () => {
    // Use a date in the same month as reference to avoid year-guessing ambiguity
    const messages = [makeMessage('1', '15.03 HolidayPlayer', '2026-03-16T10:00:00Z')];
    const { rewards, parsed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(1);
    expect(rewards[0].date).toBe('2026-03-15');
  });

  it('sets correct sourceMessageId and sourceLine', () => {
    const messages = [makeMessage('msg-42', '15.03 First\n16.03 Second')];
    const { rewards } = parseMessagesIntoRewards(messages);

    expect(rewards[0].sourceMessageId).toBe('msg-42');
    expect(rewards[0].sourceLine).toBe(0);
    expect(rewards[1].sourceMessageId).toBe('msg-42');
    expect(rewards[1].sourceLine).toBe(1);
  });

  it('handles multiple messages', () => {
    const messages = [
      makeMessage('1', '15.03 Alpha'),
      makeMessage('2', '16.03 Beta'),
    ];
    const { rewards, parsed, memberNames } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(2);
    expect(rewards).toHaveLength(2);
    expect(memberNames.size).toBe(2);
  });

  it('handles mix of valid and invalid lines', () => {
    const content = '15.03 Valid\ngarbage\n16.03 AlsoValid';
    const messages = [makeMessage('1', content)];
    const { parsed, failed } = parseMessagesIntoRewards(messages);

    expect(parsed).toBe(2);
    expect(failed).toBe(1);
  });

  it('skips backdated lines instead of ingesting them (wrong-month typo)', () => {
    // Mirrors the 04.08/05.08 incident: September messages with August dates
    // while the database already holds September rewards.
    const messages = [
      makeMessage('m1', '04.08 Samachi Saw + Bluemadcat', '2026-09-06T11:37:41Z'),
      makeMessage('m2', '05.08 Veymar + MelraynGe', '2026-09-06T11:38:56Z'),
      makeMessage('m3', '04.09 Samachi Saw + Bluemadcat', '2026-09-06T12:07:54Z'),
    ];
    const { rewards, parsed, failed, skipped } = parseMessagesIntoRewards(messages, {
      latestRewardDate: '2026-09-03',
    });

    expect(skipped).toHaveLength(2);
    expect(skipped[0].driverName).toBe('Samachi Saw');
    expect(skipped[0].reason).toBe('backdated');
    expect(skipped[1].driverName).toBe('Veymar');
    // Only the fresh line is ingested (TRAIN + VIP).
    expect(parsed).toBe(1);
    expect(failed).toBe(0);
    expect(rewards).toHaveLength(2);
    expect(rewards[0].date).toBe('2026-09-04');
    // Skipped drivers are not registered from skipped lines.
    expect(rewards.every((r) => r.date !== '2026-08-04' && r.date !== '2026-08-05')).toBe(true);
  });

  it('ingests old lines when there is no baseline yet (bootstrap)', () => {
    const messages = [makeMessage('m1', '04.08 Samachi Saw + Bluemadcat', '2026-09-06T11:37:41Z')];
    const { rewards, parsed, skipped } = parseMessagesIntoRewards(messages);

    expect(skipped).toHaveLength(0);
    expect(parsed).toBe(1);
    expect(rewards).toHaveLength(2);
  });

  it('allows rewards on the same day as the latest known reward', () => {
    const messages = [makeMessage('m1', '03.09 Driver', '2026-09-06T11:37:41Z')];
    const { rewards, parsed, skipped } = parseMessagesIntoRewards(messages, {
      latestRewardDate: '2026-09-03',
    });

    expect(skipped).toHaveLength(0);
    expect(parsed).toBe(1);
    expect(rewards).toHaveLength(1);
  });

  it('skips far-future lines', () => {
    const messages = [makeMessage('m1', '05.10 FutureDriver', '2026-09-06T12:00:00Z')];
    const { rewards, parsed, skipped } = parseMessagesIntoRewards(messages);

    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toBe('future');
    expect(parsed).toBe(0);
    expect(rewards).toHaveLength(0);
  });

  it('never ingests bot warning lines, not even as failures', () => {
    const warning = formatStaleWarning([
      { driverName: 'Samachi Saw', rewardDateISO: '2026-08-04', messageDateISO: '2026-09-06', reason: 'backdated' },
    ]);
    const messages = [makeMessage('warn1', warning, '2026-09-06T12:10:00Z')];
    const { rewards, parsed, failed, skipped } = parseMessagesIntoRewards(messages);

    expect(rewards).toHaveLength(0);
    expect(parsed).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toHaveLength(0);
  });

  it('collects date-leading garbage for warnings but ignores chatter', () => {
    const messages = [
      makeMessage('m1', '32.13 Veymar', '2026-09-06T12:00:00Z'),
      makeMessage('m2', 'hey guys, well done today', '2026-09-06T12:01:00Z'),
    ];
    const { rewards, parsed, failed, malformed } = parseMessagesIntoRewards(messages);

    expect(rewards).toHaveLength(0);
    expect(parsed).toBe(0);
    expect(failed).toBe(2); // both lines are unparseable…
    expect(malformed).toHaveLength(1); // …but only the date-leading one warns
    expect(malformed[0].rawLine).toBe('32.13 Veymar');
    expect(malformed[0].messageDate).toBe('2026-09-06');
  });

  it('never ingests malformed warnings, even when quoting date-like text', () => {
    const warning = [
      formatStaleWarning([
        { driverName: 'Samachi Saw', rewardDateISO: '2026-08-04', messageDateISO: '2026-09-06', reason: 'backdated' },
      ]),
      formatMalformedWarning([{ rawLine: '04.09 Veymar ???', messageDateISO: '2026-09-06' }]),
    ].join('\n');
    const messages = [makeMessage('warn1', warning, '2026-09-06T12:10:00Z')];
    const { rewards, parsed, failed, skipped, malformed } = parseMessagesIntoRewards(messages);

    expect(rewards).toHaveLength(0);
    expect(parsed).toBe(0);
    expect(failed).toBe(0);
    expect(skipped).toHaveLength(0);
    expect(malformed).toHaveLength(0);
  });
});
