#!/usr/bin/env node
/**
 * PreToolUse hook: запрещает запись в protected path и вне declared write set (DEV-02).
 *
 * Решение вычисляется чистой функцией `decideWrite`, покрытой allowed/denied фикстурами.
 * Hook не парсит свободный текст команды: он смотрит только на целевой путь инструмента записи.
 */
import { decideWrite, extractTargetPath } from '../decide-write.ts';
import { loadWriteSet } from '../writeset.ts';
import { readHookInput } from './read-stdin.ts';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const main = async (): Promise<void> => {
  const input = await readHookInput();
  const toolName = typeof input['tool_name'] === 'string' ? input['tool_name'] : '';
  if (!WRITE_TOOLS.has(toolName)) return;

  const targetPath = extractTargetPath(input['tool_input']);
  if (targetPath === null) return;

  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();

  const writeSet = loadWriteSet(`${projectRoot}/.claude/writeset.json`);
  const decision = decideWrite({ targetPath, projectRoot, writeSet });

  // Осознанно не возвращаем "allow": обычный permission flow должен остаться в силе.
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
