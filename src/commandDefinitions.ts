import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';

export const COMMAND_DEFINITIONS: RESTPostAPIApplicationCommandsJSONBody[] = [
  {
    name: 'train-queue',
    description: 'Show the current train queue.',
  },
  {
    name: 'help',
    description: 'Show the link to the read-only web dashboard.',
  },
];
