import 'dotenv/config';
import { COMMAND_DEFINITIONS } from './commandDefinitions.js';

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!DISCORD_TOKEN || !APPLICATION_ID || !GUILD_ID) {
  console.error('Missing required environment variables');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${APPLICATION_ID}/guilds/${GUILD_ID}/commands`;

async function registerCommands() {
  console.log('Registering commands...');
  console.log(`Commands to register: ${COMMAND_DEFINITIONS.map(c => c.name).join(', ')}`);
  
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${DISCORD_TOKEN}`,
    },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  });

  if (!response.ok) {
    const error = await response.text();
    console.error('Failed to register commands:', error);
    process.exit(1);
  }

  const data = await response.json() as Array<{ name: string }>;
  console.log(`✅ Successfully registered ${data.length} commands`);
  data.forEach((cmd) => console.log(`  - ${cmd.name}`));
}

registerCommands();
