export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  traceId?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly context: string) {}

  debug(message: string, fields: LogFields = {}): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields: LogFields = {}): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields: LogFields = {}): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields: LogFields = {}): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields: LogFields): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      context: this.context,
      message,
      ...fields,
    };

    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
}
