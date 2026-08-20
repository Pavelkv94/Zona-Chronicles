#!/usr/bin/env node
/**
 * PreToolUse hook для Bash: запрещает task-сессии операции orchestrator/lead (DEV-02).
 * Для lead-сессии (нет `.claude/writeset.json`) hook ничего не делает.
 */
import { decideBashCommand } from '../decide-bash.ts';
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

  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();
  const loaded = loadWriteSet(`${projectRoot}/.claude/writeset.json`);
  if (loaded.kind === 'lead') return;

  const decision =
    loaded.kind === 'invalid'
      ? { decision: 'deny' as const, reason: `Fail-closed: ${loaded.reason}` }
      : decideBashCommand(command);

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
