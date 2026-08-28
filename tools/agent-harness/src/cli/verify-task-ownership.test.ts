import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const CLI = fileURLToPath(new URL('./verify-task-ownership.ts', import.meta.url));

let repo: string | undefined;

const git = (args: readonly string[], cwd: string): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' }).trim();

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-harness-ownership-cli-'));
  git(['init', '-q'], dir);
  git(['config', 'user.email', 'test@example.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  repo = dir;
  return dir;
};

afterEach(() => {
  if (repo !== undefined) {
    rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

const commitFile = (root: string, relPath: string, content: string): void => {
  const parts = relPath.split('/');
  const abs = join(root, ...parts);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  git(['add', '.'], root);
  git(['commit', '-q', '-m', `add ${relPath}`], root);
};

const runCli = (
  cwd: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe('verify-task-ownership.ts (real process)', () => {
  it('без аргументов — код 2', () => {
    const root = makeRepo();
    const result = runCli(root, []);
    expect(result.status).toBe(2);
  });

  it('fail-closed: base-sha не резолвится в git-объект', () => {
    const root = makeRepo();
    commitFile(root, '.claude/tasks/I00.json', JSON.stringify({ iteration_id: 'I00', tasks: [] }));
    const result = runCli(root, ['.claude/tasks/I00.json', 'deadbeef']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Fail-closed');
  });

  it('однофайловый режим (форма вызова CI): нет нарушений — код 0', () => {
    const root = makeRepo();
    commitFile(
      root,
      '.claude/tasks/I00.json',
      JSON.stringify({
        iteration_id: 'I00',
        tasks: [{ task_id: 'I00-F1', owner_role: 'r', write_paths: ['packages/simulation/**'] }],
      }),
    );
    const baseSha = git(['rev-parse', 'HEAD'], root);

    mkdirSync(join(root, 'packages', 'simulation'), { recursive: true });
    writeFileSync(join(root, 'packages', 'simulation', 'x.ts'), 'export const x = 1;\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'work within write set'], root);

    const result = runCli(root, ['.claude/tasks/I00.json', baseSha]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Нарушений владения нет.');
  });

  it('однофайловый режим: нарушение владения — код 1', () => {
    const root = makeRepo();
    commitFile(
      root,
      '.claude/tasks/I00.json',
      JSON.stringify({
        iteration_id: 'I00',
        tasks: [{ task_id: 'I00-F1', owner_role: 'r', write_paths: ['packages/simulation/**'] }],
      }),
    );
    const baseSha = git(['rev-parse', 'HEAD'], root);
    writeFileSync(join(root, 'CLAUDE.md'), 'вне карты владения\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'out of scope change'], root);

    const result = runCli(root, ['.claude/tasks/I00.json', baseSha]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLAUDE.md');
  });

  it('N2: игнорирует более поздний (текущий) коммит с расширенной картой задач', () => {
    // Карта на baseSha — узкая. Позже (в следующем коммите, "уже после" base) карта расширяется
    // до write_paths: ["**"] — это ровно N2 в терминах CLI: источник — объект на baseSha, а не
    // что бы то ни было более позднее/текущее.
    const root = makeRepo();
    commitFile(
      root,
      '.claude/tasks/I00.json',
      JSON.stringify({
        iteration_id: 'I00',
        tasks: [{ task_id: 'I00-F1', owner_role: 'r', write_paths: ['packages/simulation/**'] }],
      }),
    );
    const baseSha = git(['rev-parse', 'HEAD'], root);

    // "Подмена": более поздний коммит расширяет карту и одновременно вносит правку вне исходной
    // карты. Если бы CLI читал текущее состояние, а не git-объект baseSha, второй коммит выглядел
    // бы легитимным.
    commitFile(
      root,
      '.claude/tasks/I00.json',
      JSON.stringify({
        iteration_id: 'I00',
        tasks: [{ task_id: 'I00-F1', owner_role: 'r', write_paths: ['**'] }],
      }),
    );
    writeFileSync(join(root, 'CLAUDE.md'), 'вне исходной карты\n');
    git(['add', '.'], root);
    git(['commit', '-q', '-m', 'forged wider map'], root);

    const result = runCli(root, ['.claude/tasks/I00.json', baseSha]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CLAUDE.md');
  });

  it('режим каталога (minor 6): объединяет все *.json внутри .claude/tasks', () => {
    const root = makeRepo();
    commitFile(
      root,
      '.claude/tasks/I00.json',
      JSON.stringify({
        tasks: [{ task_id: 'I00-F1', owner_role: 'r', write_paths: ['tools/**'] }],
      }),
    );
    commitFile(
      root,
      '.claude/tasks/I01.json',
      JSON.stringify({
        tasks: [{ task_id: 'I01-T1', owner_role: 'r', write_paths: ['packages/**'] }],
      }),
    );
    const baseSha = git(['rev-parse', 'HEAD'], root);

    const result = runCli(root, ['.claude/tasks', baseSha]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Нарушений владения нет.');
  });

  it('путь отсутствует в git-объекте base-sha — понятная ошибка, код 2', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    const baseSha = git(['rev-parse', 'HEAD'], root);
    const result = runCli(root, ['.claude/tasks/missing.json', baseSha]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('отсутствует');
  });

  /**
   * Отказ по состоянию мира не притворяется ошибкой вызова.
   *
   * Найдено при подготовке ПЕРВОГО прогона CI: `origin/main` стоит на первом коммите, каталога
   * задач в нём нет, и шаг падал, печатая «Использование: …» — то есть сообщал оператору, что
   * тот неверно набрал команду. Команда была верной; проверять было нечего. Диагностика,
   * отправляющая читателя не туда, дороже отсутствующей: по ней чинят не то.
   *
   * Код возврата НЕ изменён: fail-closed остаётся fail-closed. Изменена только диагностика, и
   * различие между двумя видами отказа теперь наблюдаемо.
   */
  it('отсутствие каталога в базе — не ошибка вызова: подсказки по аргументам нет', () => {
    const root = makeRepo();
    commitFile(root, 'a.txt', 'x\n');
    const baseSha = git(['rev-parse', 'HEAD'], root);

    const worldState = runCli(root, ['.claude/tasks', baseSha]);
    expect(worldState.status).toBe(2);
    expect(worldState.stderr).not.toContain('Использование:');
    expect(worldState.stderr).toContain('не объявлено ни одной задачи');

    // Контраст: настоящая ошибка вызова подсказку по аргументам ПЕЧАТАЕТ.
    const misuse = runCli(root, ['.claude/tasks']);
    expect(misuse.status).toBe(2);
    expect(misuse.stderr).toContain('Использование:');
  });

  it('каталог задач в git-объекте пуст — понятная ошибка, код 2', () => {
    const root = makeRepo();
    // .claude/tasks существует на диске, но пуст и никогда не коммитился — то есть его нет и в
    // git-объекте HEAD; для контраста коммитим маркер, чтобы у репозитория был хотя бы один коммит.
    commitFile(root, 'a.txt', 'x\n');
    const baseSha = git(['rev-parse', 'HEAD'], root);
    const result = runCli(root, ['.claude/tasks', baseSha]);
    expect(result.status).toBe(2);
  });
});
