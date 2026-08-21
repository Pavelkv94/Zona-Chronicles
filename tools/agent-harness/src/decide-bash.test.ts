import { describe, expect, it } from 'vitest';
import { decideBashCommand, decideBashForSession } from './decide-bash.ts';
import type { WriteSetLoadResult } from './writeset.ts';

const PROJECT_ROOT = '/repo';
const decide = (command: string) => decideBashCommand(command, PROJECT_ROOT);

describe('decideBashCommand — разрешено', () => {
  it.each([
    'pnpm test:unit',
    'pnpm lint',
    'pnpm vitest run --project unit',
    'git status',
    'git diff --name-only HEAD',
    'git add tools/usage-continuity/src/runner.ts',
    'git commit -m "I00-T02: continuity runner"',
    'node scripts/security/scan-secrets.ts',
    'ls -la',
  ])('%s', (command) => {
    expect(decide(command).decision).toBe('allow');
  });
});

describe('decideBashCommand — запрещено task-сессии', () => {
  it.each([
    ['pnpm install', 'зависимост'],
    ['pnpm add fastify', 'зависимост'],
    ['npm i -D vitest', 'зависимост'],
    ['yarn upgrade', 'зависимост'],
    ['corepack prepare pnpm@11 --activate', 'package manager'],
    ['git push origin HEAD', 'Интеграцию веток'],
    ['git merge iteration/I00-harness', 'Интеграцию веток'],
    ['git rebase main', 'Интеграцию веток'],
    ['git reset --hard HEAD~1', 'Destructive reset'],
    ['git stash push -u', 'stash'],
    ['git clean -fd', 'удаление'],
    ['git commit -m "x" --no-verify', 'Обход pre-commit'],
  ])('%s', (command, expectedFragment) => {
    const result = decide(command);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain(expectedFragment);
  });

  it('видит запрещённую команду внутри цепочки', () => {
    expect(decide('pnpm lint && git push origin HEAD').decision).toBe('deny');
  });

  it('не зависит от лишних пробелов', () => {
    expect(decide('git    push   origin   HEAD').decision).toBe('deny');
  });
});

describe('decideBashCommand — N2: запись в .claude/** через Bash запрещена task-сессии', () => {
  it.each([
    ['cat > .claude/writeset.json <<\'JSON\'\n{"write_paths":["**"]}\nJSON', 'Перенаправление'],
    ['echo x >> .claude/writeset.json', 'Перенаправление'],
    ['tee .claude/writeset.json <<< x', '`tee`'],
    ['tee -a .claude/tasks/I00.json <<< x', '`tee`'],
    ['cp forged.json .claude/writeset.json', '`cp`/`mv`'],
    ['mv forged.json .claude/tasks/I00.json', '`cp`/`mv`'],
    ['sed -i "" -e "s/tools/**/g" .claude/writeset.json', '`sed -i`'],
    ['rm -f .claude/writeset.json', 'Удаление'],
    ['rm .claude/tasks/I00.json', 'Удаление'],
    ['truncate -s 0 .claude/writeset.json', '`truncate`'],
  ] as const)('%s -> deny (%s)', (command, expectedFragment) => {
    const result = decide(command);
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain(expectedFragment);
  });

  it('чтение .claude/writeset.json без записи остаётся разрешённым', () => {
    expect(decide('cat .claude/writeset.json').decision).toBe('allow');
  });

  it('перенаправление в путь вне .claude/** остаётся разрешённым', () => {
    expect(decide('echo hi > tools/agent-harness/dist/out.txt').decision).toBe('allow');
  });

  it('видит запись в .claude/** внутри цепочки команд', () => {
    expect(decide('pnpm lint && cat > .claude/writeset.json').decision).toBe('deny');
  });
});

describe('decideBashCommand — M-8 (review, третий раунд): путь резолвится относительно projectRoot', () => {
  it('НЕ запрещает cp/mv, если целевой .claude/ лежит ВНЕ корня репозитория', () => {
    // Точное воспроизведение: построение временного git-репозитория в scratchpad — путь вне
    // projectRoot, случайно содержащий сегмент .claude/. До фикса совпадение было текстовым и
    // ловило это как нарушение.
    expect(decide('cp -R /tmp/fixture-a /tmp/fixture-b/.claude/').decision).toBe('allow');
  });

  it('НЕ запрещает диагностический вызов, где .claude/ — часть строкового литерала внутри node -e', () => {
    // Точное воспроизведение: node -e "… decideBashCommand('cp -R /tmp/a /tmp/b/.claude/') …" —
    // ничего не пишет ни в один реальный путь этого репозитория, текст `.claude/` — часть
    // строкового аргумента другой команды внутри интерпретируемого кода.
    const command =
      "node -e \"const r = require('./decide-bash.ts').decideBashCommand(" +
      "'cp -R /tmp/a /tmp/b/.claude/', '/tmp'); console.log(r)\"";
    expect(decide(command).decision).toBe('allow');
  });

  it('ВСЁ ЕЩЁ запрещает cp/mv, если целевой путь — .claude/** ВНУТРИ корня репозитория (регрессия)', () => {
    expect(decide('cp forged.json .claude/writeset.json').decision).toBe('deny');
  });

  it('резолвит абсолютный путь внутри projectRoot так же, как относительный', () => {
    expect(decide(`cp forged.json ${PROJECT_ROOT}/.claude/writeset.json`).decision).toBe('deny');
  });

  it('НЕ запрещает операцию над каталогом .claude ВНЕ репозитория с другим именем сегмента', () => {
    expect(decide('rm -rf /var/tmp/some-other-repo/.claude/writeset.json').decision).toBe('allow');
  });

  it('минорный баг: многострочная команда больше не склеивает cp из первой строки с .claude/ из последней', () => {
    // Точное воспроизведение: command.replace(/\s+/g, ' ') съедал \n, из-за чего [^|;&\n]*
    // вырождался в [^|;&]*, и multi-line команда читалась как одна строка.
    const command = [
      'cp -R /tmp/legit-a /tmp/legit-b',
      'echo done',
      'mkdir -p .claude/backup',
    ].join('\n');
    // `cp` (первая строка) не трогает .claude/** — не должен запрещаться из-за .claude/backup
    // на ТРЕТЬЕЙ, никак не связанной строке.
    expect(decide(command).decision).toBe('allow');
  });

  it('многострочная команда всё ещё ловит нарушение, если ОНО в той же строке', () => {
    const command = ['echo something', 'cp forged.json .claude/writeset.json', 'echo done'].join(
      '\n',
    );
    expect(decide(command).decision).toBe('deny');
  });

  it(
    'найдено при собственной проверке фикса: .claude/-путь как READ-ONLY аргумент ДО verb-а, ' +
      '2>&1 после — не запрещается (verb и путь никак не связаны)',
    () => {
      // Точное воспроизведение: запуск CLI-инструмента с .claude/tasks как аргументом (читается,
      // не пишется) и стандартным `2>&1` для перенаправления stderr. `[\n;|&]+`-разбиение statement-ов
      // режет одиночный `&` внутри `2>&1`, оставляя обрывок с `>` на конце, в котором ДО этого
      // остаётся `.claude/tasks` — но это путь аргумента скрипта, а не цель redirect-а.
      const command = 'node cli/verify-task-ownership.ts .claude/tasks 0a77b90 2>&1 | tail -60';
      expect(decide(command).decision).toBe('allow');
    },
  );

  it('но реальный редирект в .claude/** ПОСЛЕ 2>&1 всё ещё ловится', () => {
    const command = 'echo x 2>&1 > .claude/writeset.json';
    expect(decide(command).decision).toBe('deny');
  });
});

describe('decideBashForSession — B2: роль + write set', () => {
  const validWriteSet: WriteSetLoadResult = {
    kind: 'task',
    writeSet: {
      task_id: 'I00-R1',
      owner_role: 'tooling-implementer',
      write_paths: ['tools/agent-harness/**'],
    },
  };

  it('task-сессия с валидным write set: обычная команда разрешена', () => {
    const result = decideBashForSession({
      command: 'pnpm test:unit',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('allow');
  });

  it('task-сессия с валидным write set: lead-only команда всё равно запрещена', () => {
    const result = decideBashForSession({
      command: 'git push origin HEAD',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('deny');
  });

  it('task-сессия без write set (никогда не объявлен): deny даже безобидной команде', () => {
    const result = decideBashForSession({
      command: 'ls -la',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('без объявленного write set');
  });

  it('task-сессия после удаления writeset.json: deny (та же форма kind: lead)', () => {
    // Регрессия: `rm -f .claude/writeset.json` во время task-сессии переводит loadWriteSet
    // в тот же результат, что и «файл никогда не существовал» — оба обязаны деноситься.
    const result = decideBashForSession({
      command: 'pnpm lint',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('deny');
  });

  it('task-сессия с повреждённым writeset.json: fail-closed', () => {
    const result = decideBashForSession({
      command: 'ls',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: { kind: 'invalid', reason: 'битый JSON' },
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('Fail-closed');
  });

  it('lead-сессия: ограничений нет даже без write set', () => {
    const result = decideBashForSession({
      command: 'git push origin HEAD',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'lead',
      writeSet: { kind: 'lead' },
    });
    expect(result.decision).toBe('allow');
  });

  it('lead-сессия: ограничений нет, даже если на диске случайно лежит writeset.json', () => {
    const result = decideBashForSession({
      command: 'pnpm install',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'lead',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('allow');
  });

  it('N2: task-сессия с валидным (узким) write set не может выписать себе новый writeset.json', () => {
    // Ровно воспроизведённый обход: у задачи уже есть легитимный узкий write set
    // (tools/agent-harness/**), но она пытается расширить его Bash-командой.
    const result = decideBashForSession({
      command:
        "cat > .claude/writeset.json <<'JSON'\n" +
        '{"task_id":"I00-F1","owner_role":"tooling-implementer","write_paths":["**"],' +
        '"allow_protected_paths":["**"]}\nJSON',
      projectRoot: PROJECT_ROOT,
      sessionRole: 'task',
      writeSet: validWriteSet,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('.claude/**');
  });

  describe('M-7 (review, третий раунд): owner_role: "reviewer" — read-only, git commit запрещён', () => {
    const reviewerWriteSet: WriteSetLoadResult = {
      kind: 'task',
      writeSet: { task_id: 'I00-F5-R1', owner_role: 'reviewer', write_paths: [] },
    };

    it('обычная read-only команда (git log, pwd, ls) разрешена reviewer-у', () => {
      // До фикса пустой write_paths вообще не проходил валидацию writeset.json (см. writeset.ts),
      // поэтому у reviewer-сессии не было ни одной валидной формы — весь Bash был заблокирован,
      // а не только запись.
      expect(
        decideBashForSession({
          command: 'git log --oneline -20',
          projectRoot: PROJECT_ROOT,
          sessionRole: 'task',
          writeSet: reviewerWriteSet,
        }).decision,
      ).toBe('allow');
      expect(
        decideBashForSession({
          command: 'pwd',
          projectRoot: PROJECT_ROOT,
          sessionRole: 'task',
          writeSet: reviewerWriteSet,
        }).decision,
      ).toBe('allow');
    });

    it('git commit запрещён reviewer-у явно (ADR-008: read-only)', () => {
      const result = decideBashForSession({
        command: 'git commit -m "review notes"',
        projectRoot: PROJECT_ROOT,
        sessionRole: 'task',
        writeSet: reviewerWriteSet,
      });
      expect(result.decision).toBe('deny');
      expect(result.reason).toContain('read-only');
    });

    it('обычный lead-only список (git push) остаётся запрещён reviewer-у тоже', () => {
      const result = decideBashForSession({
        command: 'git push origin HEAD',
        projectRoot: PROJECT_ROOT,
        sessionRole: 'task',
        writeSet: reviewerWriteSet,
      });
      expect(result.decision).toBe('deny');
    });

    it('git commit остаётся РАЗРЕШЁН обычной (не reviewer) роли (регрессия)', () => {
      const result = decideBashForSession({
        command: 'git commit -m "I00-T02: continuity runner"',
        projectRoot: PROJECT_ROOT,
        sessionRole: 'task',
        writeSet: validWriteSet,
      });
      expect(result.decision).toBe('allow');
    });
  });
});
