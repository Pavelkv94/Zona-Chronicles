#!/usr/bin/env node
/**
 * PreToolUse hook для Bash: запрещает task-сессии операции orchestrator/lead (DEV-02).
 *
 * Роль решается payload-ом (`agent_id`/`agent_type` — `classifySession`), а не наличием
 * `.claude/writeset.json` (B2 review finding): для lead-сессии hook ничего не делает; для
 * task-сессии без валидного write set команда fail-closed деноситься, даже если файл удалён
 * самой сессией.
 */
import { decideBashForSession } from '../decide-bash.ts';
import { classifySession } from '../session-role.ts';
import { loadWriteSet } from '../writeset.ts';
import { readHookInput } from './read-stdin.ts';

const main = async (): Promise<void> => {
  const input = await readHookInput();
  if (input['tool_name'] !== 'Bash') return;

  const toolInput = input['tool_input'];
  const command =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>)['command']
      : undefined;
  if (typeof command !== 'string') return;

  const sessionRole = classifySession(input);
  if (sessionRole === 'lead') return;

  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();
  const writeSet = loadWriteSet(`${projectRoot}/.claude/writeset.json`);
  const decision = decideBashForSession({ command, sessionRole, writeSet });

  if (decision.decision === 'deny') {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      }),
    );
  }
};

await main();
