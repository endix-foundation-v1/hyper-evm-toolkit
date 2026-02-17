import { mkdir, appendFile, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EngineCommand } from '../types/engine.js';

type CommandLogEntryType = 'command' | 'event';

interface CommandLogEntry {
  entryType: CommandLogEntryType;
  timestampMs: number;
  payload: unknown;
}

export class CommandLog {
  constructor(private readonly filePath: string) {}

  async appendCommand(command: EngineCommand): Promise<void> {
    await this.appendEntry({
      entryType: 'command',
      timestampMs: Date.now(),
      payload: command,
    });
  }

  async appendEvent(payload: unknown): Promise<void> {
    await this.appendEntry({
      entryType: 'event',
      timestampMs: Date.now(),
      payload,
    });
  }

  async readCommands(): Promise<EngineCommand[]> {
    try {
      const content = await readFile(this.filePath, 'utf8');
      const commands: EngineCommand[] = [];

      for (const line of content.split('\n')) {
        if (!line.trim()) {
          continue;
        }

        const parsed = JSON.parse(line) as CommandLogEntry;
        if (parsed.entryType === 'command') {
          commands.push(parsed.payload as EngineCommand);
        }
      }

      return commands;
    } catch {
      return [];
    }
  }

  private async appendEntry(entry: CommandLogEntry): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
  }
}
