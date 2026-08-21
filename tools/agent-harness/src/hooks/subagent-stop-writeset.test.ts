import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HOOK = fileURLToPath(new URL('./subagent-stop-writeset.ts', import.meta.url));

let repo: string | undefined;

const git = (args: readonly string[], cwd: string): void => {
  execFileSync('git', [...args], { cwd, stdio: 'pipe' });
};

/** Git-репозиторий с одним seed-коммитом (нужен для `git diff --name-only HEAD`). */
const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-stop-hook-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  mkdirSync(join(dir, 'packages', 'simulation'), { recursive: true });
  writeFileSync(join(dir, 'packages', 'simulation', 'seed.ts'), 'export const seed = 1;\n');
  writeFileSync(join(dir, 'README.md'), '# repo\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  repo = dir;
  return dir;
};

afterEach(() => {
  if (repo !== undefined) {
    rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

/**
 * Lead коммитит `.claude/writeset.json`/`.claude/tasks/*.json` до запуска subagent-а (это часть
 * orchestration-flow, не работы задачи) — поэтому здесь фикстуры коммитятся сразу, а не остаются
 * untracked. Иначе git diff видел бы сам control-файл как изменение task-сессии и ошибочно бы
 * репортил protected-path violation на `.claude/**`, никак не относящийся к B2.
 */
const commitAll = (root: string, message: string): void => {
  git(['add', '.'], root);
  git(['commit', '-q', '-m', message], root);
};

const writeWriteSet = (root: string, writeSet: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'writeset.json'), JSON.stringify(writeSet));
  commitAll(root, 'lead: declare write set');
};

const writeTasksFile = (root: string, name: string, content: Record<string, unknown>): void => {
  mkdirSync(join(root, '.claude', 'tasks'), { recursive: true });
  writeFileSync(join(root, '.claude', 'tasks', name), JSON.stringify(content));
  commitAll(root, 'lead: declare tasks map');
};

const runHook = (
  cwd: string,
  payload: Record<string, unknown>,
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('node', [HOOK], {
    cwd,
    input: JSON.stringify({ cwd, ...payload }),
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('subagent-stop-writeset.ts (real process)', () => {
  it('lead-сессия: не ограничена write set-ом, код 0, ничего не пишет в stderr', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'changed by lead\n');
    const result = runHook(root, {});
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия, валидный writeset.json, diff внутри write set — код 0', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['packages/simulation/**'],
    });
    writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 2;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия, валидный writeset.json, diff вне write set — код 2 с причиной', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['packages/simulation/**'],
    });
    writeFileSync(join(root, 'README.md'), 'изменено задачей вне write set\n');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('README.md');
    expect(result.stderr).toContain('I00-R1');
  });

  it('task-сессия без writeset.json, но с покрывающей .claude/tasks/*.json — код 0', () => {
    const root = makeRepo();
    writeTasksFile(root, 'I00.json', {
      iteration_id: 'I00',
      lead_paths: ['README.md'],
      tasks: [
        {
          task_id: 'I00-R1',
          owner_role: 'tooling-implementer',
          write_paths: ['packages/simulation/**'],
        },
      ],
    });
    writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 3;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('task-сессия без writeset.json, .claude/tasks/*.json не покрывает файл — код 2', () => {
    const root = makeRepo();
    writeTasksFile(root, 'I00.json', {
      iteration_id: 'I00',
      tasks: [{ task_id: 'I00-R2', owner_role: 'r', write_paths: ['packages/domain/**'] }],
    });
    writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 4;\n');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('packages/simulation/seed.ts');
  });

  it('B2: task-сессия без writeset.json и без .claude/tasks — код 2, явная причина', () => {
    const root = makeRepo();
    writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 5;\n');
    const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('.claude/writeset.json');
    expect(result.stderr).toContain('.claude/tasks');
  });

  it('B2: воспроизводит rm -f .claude/writeset.json той же task-сессией — завершение блокируется', () => {
    const root = makeRepo();
    writeWriteSet(root, {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['packages/simulation/**'],
    });
    writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 6;\n');

    // До удаления: diff внутри write set — прошло бы.
    const before = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(before.status).toBe(0);

    // Ревью-сценарий: task-сессия удаляет собственный дискриминатор.
    rmSync(join(root, '.claude', 'writeset.json'));
    // И нет .claude/tasks/*.json, который мог бы стать fallback-ом.

    const after = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
    expect(after.status).toBe(2);
    expect(after.stderr.length).toBeGreaterThan(0);
  });

  it('fail-closed на повреждённый .claude/writeset.json (task-сессия)', () => {
    const root = makeRepo();
    // N2: источник теперь — git-объект HEAD, а не рабочее дерево, поэтому битый файл обязан быть
    // закоммичен, чтобы hook вообще его увидел (некоммиченная порча не расширяет права — это и есть
    // фикс N2 — но и не должна давать fail-closed за то, чего hook не видит).
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'writeset.json'), '{not json');
    commitAll(root, 'lead: declare broken write set');
    const result = runHook(root, { agent_id: 'agent-1' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Fail-closed');
  });

  describe('N1 (review, второй раунд): lead_paths — не владение task-сессии', () => {
    it('удаление writeset.json + покрытие только lead_paths (README.md, .claude/**) — код 2', () => {
      // Точное воспроизведение из отчёта: task-сессия меняет README.md и
      // .claude/settings.autonomous.json, затем удаляет .claude/writeset.json. До фикса N1 это
      // давало exit 0, потому что checkOwnership трактовала lead_paths как ownedBy: 'lead'.
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeTasksFile(root, 'I00.json', {
        iteration_id: 'I00',
        lead_paths: ['README.md', '.claude/**'],
        tasks: [
          {
            task_id: 'I00-F1',
            owner_role: 'tooling-implementer',
            write_paths: ['packages/simulation/**'],
          },
        ],
      });
      writeFileSync(join(root, 'README.md'), 'изменено task-сессией\n');
      mkdirSync(join(root, '.claude'), { recursive: true });
      writeFileSync(join(root, '.claude', 'settings.autonomous.json'), '{"tampered":true}');

      rmSync(join(root, '.claude', 'writeset.json'));

      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('README.md');
    });
  });

  describe('N2 (review, второй раунд): источник — git-объект HEAD, не рабочее дерево', () => {
    it('подмена .claude/writeset.json в рабочем дереве (без коммита) не расширяет write_paths', () => {
      // Точное воспроизведение: task-сессия выписывает себе {"write_paths":["**"],
      // "allow_protected_paths":["**"]} через Bash-редирект (здесь эмулируется прямой правкой
      // рабочего дерева, т.к. слой decide-bash — отдельный, PreToolUse-контроль). До фикса N2 hook
      // читал этот файл с диска и доверял ему; после — читает git-объект HEAD.
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'CLAUDE.md'), 'изменено вне declared write set\n');

      // Подмена рабочего дерева без коммита — тот же эффект, что у `cat > .claude/writeset.json`.
      writeFileSync(
        join(root, '.claude', 'writeset.json'),
        JSON.stringify({
          task_id: 'I00-F1',
          owner_role: 'tooling-implementer',
          write_paths: ['**'],
          allow_protected_paths: ['**'],
        }),
      );

      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('CLAUDE.md');
    });

    it('легитимная работа внутри write set остаётся кодом 0 (регрессия)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 7;\n');
      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  describe('B-1 (review, третий раунд): база сравнения — не HEAD', () => {
    it('коммит нарушения task-сессией больше не даёт код 0 (было: HEAD после коммита == diff пуст)', () => {
      // Точное воспроизведение из отчёта: до фикса `git diff --name-only HEAD` вычислялся
      // относительно HEAD, который сама task-сессия двигает своим коммитом — после коммита
      // нарушение переставало быть видно (`changed` пуст), hook отдавал 0.
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'forbidden.txt'), 'запись вне write set\n');
      git(['add', 'forbidden.txt'], root);
      git(['commit', '-q', '-m', 'task-сессия коммитит своё нарушение'], root);

      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('forbidden.txt');
      expect(result.stderr).toContain('I00-F1');
    });

    it('коммит нарушения через .claude/tasks/*.json fallback тоже ловится (task-session mode)', () => {
      const root = makeRepo();
      writeTasksFile(root, 'I00.json', {
        iteration_id: 'I00',
        lead_paths: ['README.md'],
        tasks: [
          {
            task_id: 'I00-R2',
            owner_role: 'tooling-implementer',
            write_paths: ['packages/simulation/**'],
          },
        ],
      });
      writeFileSync(join(root, 'forbidden.txt'), 'запись вне карты задач\n');
      git(['add', 'forbidden.txt'], root);
      git(['commit', '-q', '-m', 'task-сессия коммитит своё нарушение'], root);

      const result = runHook(root, { agent_id: 'agent-1' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('forbidden.txt');
    });

    it('легитимный коммит внутри write set остаётся кодом 0 (регрессия к диффу от нового anchor)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 8;\n');
      git(['add', 'packages/simulation/seed.ts'], root);
      git(['commit', '-q', '-m', 'task-сессия коммитит легитимную работу'], root);

      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });

    it(
      'lead-коммит самого control-файла НЕ распознаётся как нарушение task-сессии ' +
        '(эмпирическая проверка причины отклонения от буквального base_commit из finding-а)',
      () => {
        // Если бы базой служил round-level base_commit (предшествующий коммиту control-файла),
        // сам факт появления .claude/writeset.json в diff ошибочно читался бы как protected-path
        // нарушение task-сессии, хотя его добавил lead. Anchor = «последний коммит, менявший сам
        // control-файл» этого не допускает: до диффа он уже входит в базу.
        const root = makeRepo();
        writeWriteSet(root, {
          task_id: 'I00-F1',
          owner_role: 'tooling-implementer',
          write_paths: ['packages/simulation/**'],
        });
        // Task-сессия ничего не меняла — только что объявлен write set.
        const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
        expect(result.status).toBe(0);
        expect(result.stderr).toBe('');
      },
    );
  });

  describe('M-2 (review, третий раунд): канарейка отсутствия сигнала роли', () => {
    it('declared write set есть, agent_id/agent_type отсутствуют — код 2, а не молчаливый allow', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      // Файл вне write set: до фикса эта комбинация («payload похож на lead») пропускала бы
      // проверку целиком (ранний return на sessionRole === 'lead').
      writeFileSync(join(root, 'forbidden.txt'), 'x\n');

      const result = runHook(root, {}); // ни agent_id, ни agent_type
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('M-2');
      expect(result.stderr).toContain('agent_id');
    });

    it('declared write set есть через .claude/tasks/*.json, сигнала роли нет — тоже код 2', () => {
      const root = makeRepo();
      writeTasksFile(root, 'I00.json', {
        iteration_id: 'I00',
        tasks: [
          { task_id: 'I00-R2', owner_role: 'tooling-implementer', write_paths: ['tools/**'] },
        ],
      });
      const result = runHook(root, {});
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('M-2');
    });

    it('write set не объявлен вовсе, сигнала роли нет — код 0 (genuine lead, backward-compat)', () => {
      const root = makeRepo();
      writeFileSync(join(root, 'anything.ts'), 'x\n');
      const result = runHook(root, {});
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });

  describe('minor 5 (review, третий раунд): ошибка git не маскируется под «нарушений нет»', () => {
    it('повреждённый .git/index — код 2 с явной причиной, а не молчаливый allow', () => {
      // Точечная фикстура: порча .git/index ломает именно `git diff`/`git ls-files` (им нужен
      // индекс), но НЕ `git show`/`git log` (читают только object DB) — то есть чтение
      // control-файла и резолв anchor-коммита (B-1) остаются рабочими, а сам подсчёт изменённых
      // файлов — нет. Раньше (`git()`, ловивший любую ошибку в []) это тихо превращалось в
      // «нарушений нет» и код 0.
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F1',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, '.git', 'index'), 'not-a-real-index');

      const result = runHook(root, { agent_id: 'agent-1', agent_type: 'tooling-implementer' });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Fail-closed');
      expect(result.stderr).toContain('git diff');
    });
  });

  describe('F5-1 (blocker, живой прогон раунда I00-F5): эскалация без бесконечного цикла', () => {
    it('первое срабатывание блокирует (код 2), точный повтор для той же сессии — пропускает (код 0)', () => {
      // Точное воспроизведение: F5-T2 была принята и закрыта, но получала один и тот же вердикт
      // 12 раз подряд — файлы вне её write set ей не принадлежали, откатить их она не могла.
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'README.md'), 'изменил lead, не эта сессия\n');
      const payload = {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1a',
      };

      const first = runHook(root, payload);
      expect(first.status).toBe(2);
      expect(first.stderr).toContain('README.md');

      // Состояние дерева не изменилось (сессия не может откатить чужой файл) — SubagentStop
      // вызывается заново с тем же payload, ровно как в описанном цикле.
      const second = runHook(root, payload);
      expect(second.status).toBe(0);
      expect(second.stderr).toContain('F5-1');
    });

    it('третий вызов с тем же payload остаётся кодом 0 (не откатывается обратно в блокировку)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'README.md'), 'x\n');
      const payload = {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1b',
      };

      runHook(root, payload);
      runHook(root, payload);
      const third = runHook(root, payload);
      expect(third.status).toBe(0);
    });

    it('другая сессия (другой session_id) с той же причиной блокируется заново (код 2)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'README.md'), 'x\n');

      const first = runHook(root, {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1c',
      });
      expect(first.status).toBe(2);

      const otherSession = runHook(root, {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1d',
      });
      expect(otherSession.status).toBe(2);
      expect(otherSession.stderr).toContain('README.md');
    });

    it('новая, отличающаяся причина для той же сессии блокирует заново (не гасится старым состоянием)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      const payload = {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1e',
      };

      writeFileSync(join(root, 'README.md'), 'x\n');
      const first = runHook(root, payload);
      expect(first.status).toBe(2);

      const secondSame = runHook(root, payload);
      expect(secondSame.status).toBe(0); // эскалация той же причины уже прошла

      // Причина меняется: добавился ЕЩЁ один файл вне write set — новая информация, блокирует.
      writeFileSync(join(root, 'CLAUDE.md'), 'x\n');
      const thirdNewReason = runHook(root, payload);
      expect(thirdNewReason.status).toBe(2);
      expect(thirdNewReason.stderr).toContain('CLAUDE.md');
    });

    it('без session_id в payload дедуп невозможен — блокирует безусловно на каждый вызов', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'README.md'), 'x\n');
      const payload = { agent_id: 'agent-1', agent_type: 'tooling-implementer' }; // нет session_id

      const first = runHook(root, payload);
      expect(first.status).toBe(2);
      const second = runHook(root, payload);
      expect(second.status).toBe(2);
    });

    it('диагностика: сообщение содержит session_id и диапазон base..HEAD (п.3 требования)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'README.md'), 'x\n');
      const result = runHook(root, {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1-diag',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('session_id=sess-f5-1-diag');
      expect(result.stderr).toContain('range=');
      expect(result.stderr).toContain('..HEAD');
    });

    it('легитимный вызов без нарушений остаётся кодом 0 независимо от session_id (регрессия)', () => {
      const root = makeRepo();
      writeWriteSet(root, {
        task_id: 'I00-F5-T2',
        owner_role: 'tooling-implementer',
        write_paths: ['packages/simulation/**'],
      });
      writeFileSync(join(root, 'packages', 'simulation', 'seed.ts'), 'export const seed = 9;\n');
      const result = runHook(root, {
        agent_id: 'agent-1',
        agent_type: 'tooling-implementer',
        session_id: 'sess-f5-1-ok',
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    });
  });
});
