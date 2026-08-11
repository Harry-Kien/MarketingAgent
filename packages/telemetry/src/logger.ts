import { redact } from "./redact.ts";

export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(
  sink: LogSink = (line) => process.stdout.write(line + "\n"),
): Logger {
  const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
    const safe = (fields ? redact(fields) : {}) as Record<string, unknown>;
    // Reserved keys are written last so caller fields can never shadow them.
    sink(JSON.stringify({ ...safe, level, msg, time: new Date().toISOString() }));
  };
  return {
    info: (m, f) => { emit("info", m, f); },
    warn: (m, f) => { emit("warn", m, f); },
    error: (m, f) => { emit("error", m, f); },
  };
}

export const logger = createLogger();
