import { z } from "zod";

const serverEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]),
  DATABASE_URL: z
    .string()
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_URL must be a postgres:// connection string",
    }),
  // Optional: only apps/worker's outbox-draining path ever needs this (the
  // smos_worker credential, 0017_outbox_claim_token.sql) -- apps/web has no
  // reason to hold it. When present, it is validated the same way
  // DATABASE_URL is.
  DATABASE_WORKER_URL: z
    .string()
    .refine((v) => v.startsWith("postgres://") || v.startsWith("postgresql://"), {
      message: "DATABASE_WORKER_URL must be a postgres:// connection string",
    })
    .optional(),
  OTEL_SERVICE_NAME: z.string().min(1),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

/**
 * Validate the environment. The error message deliberately reports only the
 * failing key and its rule, never the received value, because these values
 * are secrets (threat T4).
 */
export function parseServerEnv(raw: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(raw);
  if (result.success) return Object.freeze(result.data);
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid server environment -> ${detail}`);
}
