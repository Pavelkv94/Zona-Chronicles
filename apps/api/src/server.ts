/**
 * apps/api — Fastify skeleton (I00). Читает только `/health` (liveness) и `/ready` (readiness).
 *
 * Наблюдательские read-only маршруты (`GET /v1/...`, SSE) регистрируются в `observer-routes.ts`
 * (I03, §7 03_TECHNICAL_DESIGN). Публичный API не содержит write-маршрутов
 * (POST/PUT/PATCH/DELETE) — это гарантирует `server.contract.test.ts` обходом ТАБЛИЦЫ маршрутов,
 * а не списком известных путей и не кодом ниже.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { Type, type TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { registerObserverRoutes, type ObserverRoutesOptions } from './observer-routes.ts';

/** Инъектированный источник uptime — тест не зависит от wall clock. */
export type UptimePort = {
  readonly uptimeMs: () => number;
};

export type BuildServerDeps = {
  /** Immutable deployment identifier (§12 03_TECHNICAL_DESIGN) — не секрет, безопасен для /health. */
  readonly deploymentId: string;
  /** Placeholder до I01, где появляется реальная schema versioning (@zona/contracts). */
  readonly schemaVersion: number;
  /** Placeholder до I01/I02B, где появляется реальный rules bundle versioning. */
  readonly rulesVersion: string;
  readonly uptime: UptimePort;
  /**
   * Наблюдательские маршруты. Необязательны: `/health` и `/ready` обязаны отвечать и тогда, когда
   * проекция недоступна — иначе readiness-проверка перестала бы отличать «сервис не поднялся» от
   * «мир ещё не создан».
   */
  readonly observer?: ObserverRoutesOptions;
};

const HealthResponseSchema = Type.Object(
  {
    status: Type.Literal('ok'),
    deployment_id: Type.String(),
    schema_version: Type.Number(),
    rules_version: Type.String(),
    uptime_ms: Type.Number(),
  },
  { additionalProperties: false },
);

const ReadyResponseSchema = Type.Object(
  {
    status: Type.Literal('ready'),
  },
  { additionalProperties: false },
);

/** Builds the Fastify instance. Server construction has no side effects beyond route registration. */
export function buildServer(deps: BuildServerDeps): FastifyInstance {
  const app = Fastify().withTypeProvider<TypeBoxTypeProvider>();

  app.get('/health', { schema: { response: { 200: HealthResponseSchema } } }, () => ({
    status: 'ok' as const,
    deployment_id: deps.deploymentId,
    schema_version: deps.schemaVersion,
    rules_version: deps.rulesVersion,
    uptime_ms: deps.uptime.uptimeMs(),
  }));

  // Readiness (§12 03_TECHNICAL_DESIGN) отличается от liveness: в I00 без зависимостей для проверки,
  // поэтому реализация — фиксированный ответ. Реальная readiness-логика (DB/outbox) появится позже.
  app.get('/ready', { schema: { response: { 200: ReadyResponseSchema } } }, () => ({
    status: 'ready' as const,
  }));

  if (deps.observer !== undefined) {
    registerObserverRoutes(app, deps.observer);
  }

  return app;
}
