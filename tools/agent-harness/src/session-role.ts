/**
 * Позитивная классификация роли hook-сессии (DEV-02, ADR-008, B2 review finding).
 *
 * Проблема, которую закрывает этот модуль: до фикса роль сессии выводилась из наличия
 * `.claude/writeset.json` на диске. Отсутствие файла трактовалось как «lead-сессия, ограничений
 * нет» — а файл лежит внутри `.claude/**`, то есть удаляем той же task-сессией, которую он должен
 * ограничивать (`rm -f .claude/writeset.json`). Это единый дискриминатор без положительного
 * признака — классический fail-open.
 *
 * Исправление: у hook payload (Claude Code hooks reference) есть поля, которые сессия сама не
 * контролирует и не может подделать записью в repo. Общие для всех hook-событий поля —
 * `session_id`, `cwd`, `permission_mode`, `hook_event_name`; когда hook вызван внутри subagent-сессии
 * (запущенной через Task/Agent tool), payload дополнительно содержит непустые `agent_id` и
 * `agent_type`. Lead/orchestrator-сессия этих полей не имеет вообще. Значит: непустой `agent_id`
 * или `agent_type` в payload — положительный и неподделываемый признак task-сессии; их отсутствие —
 * признак lead-сессии.
 *
 * Эта классификация не зависит от файловой системы: она читает только уже распарсенный payload.
 */
export type SessionRole = 'lead' | 'task';

const hasNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/**
 * Определяет роль сессии по hook payload.
 *
 * `'task'`  — payload содержит непустой `agent_id` и/или `agent_type` (subagent-сессия).
 * `'lead'`  — оба поля отсутствуют или пусты (orchestrator-сессия).
 */
export const classifySession = (input: Readonly<Record<string, unknown>>): SessionRole =>
  hasNonEmptyString(input['agent_id']) || hasNonEmptyString(input['agent_type']) ? 'task' : 'lead';
