import 'dotenv/config';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

type DiscordAttachment = {
  id: string;
  url: string;
  filename: string;
  content_type?: string;
};

type DiscordMessage = {
  id: string;
  timestamp?: string;
  attachments: DiscordAttachment[];
};

type ParsedArgs = {
  channelId?: string;
  outDir?: string;
  messages?: number;
  leaderboards?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {};
  for (const arg of argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [flag, value] = arg.substring(2).split('=');
    if (!value) continue;

    if (flag === 'channel') parsed.channelId = value;
    if (flag === 'outDir') parsed.outDir = value;
    if (flag === 'messages') {
      const count = Number.parseInt(value, 10);
      if (!Number.isNaN(count) && count > 0) {
        parsed.messages = Math.min(count, 100); // Discord API limit safeguard
      }
    }
    if (flag === 'leaderboards') {
      const count = Number.parseInt(value, 10);
      if (!Number.isNaN(count) && count > 0) {
        parsed.leaderboards = Math.min(count, 50);
      }
    }
  }
  return parsed;
}

function ensureDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

async function fetchRecentMessages(channelId: string, token: string, apiBase: string, limit: number): Promise<DiscordMessage[]> {
  const url = `${apiBase}/channels/${channelId}/messages?limit=${limit}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.status} ${response.statusText}`);
  }

  return await response.json() as DiscordMessage[];
}

function getImageAttachments(message: DiscordMessage): DiscordAttachment[] {
  return message.attachments.filter((attachment) => {
    if (attachment.content_type) {
      return attachment.content_type.startsWith('image/');
    }
    return /(\.png|\.jpe?g|\.webp|\.bmp)$/i.test(attachment.url);
  });
}

async function downloadAttachment(attachment: DiscordAttachment, token: string, targetDir: string): Promise<string> {
  const response = await fetch(attachment.url, {
    headers: {
      Authorization: `Bot ${token}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment ${attachment.id}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = attachment.filename.includes('.')
    ? attachment.filename.substring(attachment.filename.lastIndexOf('.') + 1)
    : 'png';
  const sanitizedExtension = extension.toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const fileName = `${attachment.id}.${sanitizedExtension}`;
  const filePath = join(targetDir, fileName);

  writeFileSync(filePath, buffer);
  return filePath;
}

function formatTimestamp(timestamp?: string): string {
  if (!timestamp) {
    return 'unknown-time';
  }
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return 'invalid-time';
  }
  return date.toISOString().replace(/[:.]/g, '-');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const token = process.env.DISCORD_BOT_TOKEN;
  const apiBase = process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
  const channelId = args.channelId ?? process.env.LEADERBOARD_CHANNEL_ID;
  const outDir = args.outDir ? resolve(args.outDir) : resolve('./tmp/leaderboard');
  const desiredLeaderboards = args.leaderboards ?? 5;
  const minMessagesRequired = Math.max(1, desiredLeaderboards) * 2;
  const messageLimit = args.messages
    ? Math.max(args.messages, minMessagesRequired)
    : minMessagesRequired;

  if (!token) {
    console.error('Missing DISCORD_BOT_TOKEN environment variable.');
    process.exitCode = 1;
    return;
  }

  if (!channelId) {
    console.error('Missing leaderboard channel id. Provide via LEADERBOARD_CHANNEL_ID env variable or --channel=<id>.');
    process.exitCode = 1;
    return;
  }

  ensureDirectory(outDir);

  console.log(`Fetching last ${messageLimit} message(s) from channel ${channelId}...`);
  const messages = await fetchRecentMessages(channelId, token, apiBase, messageLimit);

  if (messages.length === 0) {
    console.error('No messages found in the channel.');
    process.exitCode = 1;
    return;
  }

  const orderedMessages = [...messages].sort((a, b) => {
    const first = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const second = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return second - first;
  });

  const availableLeaderboards = Math.floor(orderedMessages.length / 2);
  const leaderboardsToProcess = Math.min(desiredLeaderboards, availableLeaderboards);

  if (leaderboardsToProcess === 0) {
    console.warn('Not enough messages to form a complete leaderboard. Expected pairs of messages.');
    return;
  }

  if (leaderboardsToProcess < desiredLeaderboards) {
    console.warn(`Requested ${desiredLeaderboards} leaderboard(s) but only found ${leaderboardsToProcess} in the fetched messages.`);
  }

  console.log(`Preparing ${leaderboardsToProcess} leaderboard folder(s)...`);

  const savedFiles: string[] = [];

  for (let index = 0; index < leaderboardsToProcess; index += 1) {
    const sliceStart = index * 2;
    const groupMessages = orderedMessages.slice(sliceStart, sliceStart + 2);
    if (groupMessages.length < 2) {
      console.warn(`Skipping incomplete leaderboard group starting at index ${index}.`);
      continue;
    }

    const groupLabel = formatTimestamp(groupMessages[0].timestamp);
    const leaderboardDir = join(outDir, `leaderboard-${index + 1}-${groupLabel}`);
    ensureDirectory(leaderboardDir);

    console.log(`\nProcessing leaderboard ${index + 1}/${leaderboardsToProcess} -> ${leaderboardDir}`);

    for (const message of groupMessages) {
      const attachments = getImageAttachments(message);
      if (attachments.length === 0) {
        console.warn(`Message ${message.id} has no image attachments. Skipping.`);
        continue;
      }

      console.log(` Message ${message.id} (${attachments.length} image(s))`);

      for (const attachment of attachments) {
        console.log(`  Downloading ${attachment.filename} (attachment ${attachment.id})...`);
        const filePath = await downloadAttachment(attachment, token, leaderboardDir);
        savedFiles.push(filePath);
      }
    }
  }

  if (savedFiles.length === 0) {
    console.warn('No image attachments were downloaded.');
    return;
  }

  console.log('\nDownloaded files:');
  for (const file of savedFiles) {
    console.log(file);
  }

  console.log(`\nTotal attachments saved: ${savedFiles.length}`);
}

main().catch((error) => {
  console.error('Failed to download leaderboard screenshots:', error);
  process.exitCode = 1;
});
