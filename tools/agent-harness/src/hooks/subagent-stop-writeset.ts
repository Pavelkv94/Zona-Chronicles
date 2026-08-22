#!/usr/bin/env node
/**
 * SubagentStop hook: сверяет фактический git diff с declared write set (DEV-02, A4).
 *
 * Контроль результата, а не намерения: даже если запись прошла мимо PreToolUse
 * (например, через Bash), расхождение обнаруживается до завершения задачи.
 *
 * B2 review finding: роль сессии решается hook payload-ом (`agent_id`/`agent_type` —
 * `classifySession`), а не наличием `.claude/writeset.json`. Для task-сессии сверка выполняется
 * безусловно:
 *   1. если `.claude/writeset.json` валиден — сверяем diff с ним;
 *   2. если файла нет — используем карту задач итерации `.claude/tasks/*.json`;
 *   3. если нет ни того, ни другого — завершение блокируется явной причиной, а не пропускается.
 *
 * N1/N2 review finding (второй раунд верификации), два независимых слоя:
 *
 * N1 — `.claude/tasks/*.json` содержит `lead_paths`, и до фикса совпадение с ним трактовалось
 * как владение lead-а даже в контексте task-сессии. Исправлено через
 * `checkOwnership(..., 'task-session')`: в этом режиме совпадение только с `lead_paths` —
 * нарушение (`lead-only`), а не владение.
 *
 * N2 — источник ограничений (`.claude/writeset.json`, `.claude/tasks/*.json`) читался с диска,
 * то есть из write path, доступного самой ограничиваемой task-сессии через Bash в обход
 * PreToolUse-слоёв. Исправлено чтением из git-объекта `DECLARATION_REF` (`loadWriteSetFromGit`/
 * `loadTaskDeclarationsFromGit`, `../git-source.ts`): рабочее дерево для этого решения не
 * читается вовсе.
 *
 * B-1 (третий, верификационный раунд) — база сравнения для САМОГО diff (не для чтения control-
 * файлов) была `HEAD`, то есть той же ссылкой, что двигается вместе с каждым коммитом
 * task-сессии. Демонстрация: субагент пишет файл вне write set и коммитит его — `git diff
 * --name-only HEAD` после коммита пуст, `ls-files --others` тоже пуст (файл больше не untracked),
 * hook отдавал exit 0. Фикс — `resolveLastCommitTouchingPath`: базой для diff служит последний
 * коммит, изменивший сам control-файл (`.claude/writeset.json` или `.claude/tasks/`), а не
 * `DECLARATION_REF`. Этот коммит не двигается от коммитов task-сессии, которые не трогают
 * control-файл (а трогать его task-сессия не вправе — protected path).
 *
 * Отклонение от буквальной формулировки finding-а (там предлагалось использовать поле
 * `base_commit` из `.claude/tasks/*.json`, например `daf148c` в `.claude/tasks/I00-F5.json`):
 * это поле обозначает начало ВСЕГО раунда фиксов (до того, как lead закоммитил
 * `.claude/writeset.json`/`.claude/tasks/I00-F5.json`), а не момент, когда запущена ЭТА
 * конкретная task-сессия. Если использовать его как diff-базу здесь, объявление самого control-
 * файла (коммит lead-а, случившийся уже ПОСЛЕ `base_commit`) само попадёт в diff и будет
 * ошибочно распознано как protected-path/lead-only нарушение task-сессии, хотя её изменил lead.
 * Проверено эмпирически на этом репозитории: `git diff --name-only daf148c HEAD -- .claude/`
 * возвращает `.claude/tasks/I00-F5.json` и `.claude/writeset.json` — оба добавлены lead-ом.
 * `base_commit` остаётся корректной базой для отдельного, ручного, cross-task аудита
 * (`cli/verify-task-ownership.ts`, режим `lead-audit`, где такое совпадение — законное владение
 * lead-а, а не нарушение), но не для этого hook-а, который проверяет ровно одну task-сессию в
 * режиме `task-session` (см. `task-ownership.ts`, `OwnershipMode`).
 *
 * M-2 (третий раунд) — «канарейка» отсутствия сигнала роли: `classifySession` возвращает
 * `'lead'`, когда payload не содержит `agent_id`/`agent_type`. До фикса это безусловно пропускало
 * проверку (см. историю B2/N1/N2 выше). Здесь это остаётся верным, только если на
 * `DECLARATION_REF` ДЕЙСТВИТЕЛЬНО нет объявленного write set: SubagentStop штатно происходит
 * только при завершении subagent-сессии, поэтому сочетание «есть объявленная задача» и «нет
 * сигнала роли» — не свидетельство lead-сессии, а потенциальная потеря дискриминатора платформой
 * (см. `session-role.ts`, minor 4). В этом случае завершение блокируется с явной причиной.
 *
 * minor 5 (третий раунд) — старый `git()`-хелпер проглатывал любую ошибку подпроцесса (битый
 * git, отсутствующий бинарник, повреждённый репозиторий) и возвращал `[]`, неотличимое от
 * «нарушений нет». `runGit`/`gitNameList`/`changedFilesSince` ниже возвращают explicit
 * `{ kind: 'error' }`, и вызывающий код обязан fail-closed на этот случай, а не трактовать его
 * как пустой diff.
 *
 * F5-1 (blocker, живой прогон раунда I00-F5) — эскалация без выхода. `exit 2` на SubagentStop
 * блокирует остановку subagent-сессии и, по контракту hook-а, ожидает, что сессия ИСПРАВИТ
 * причину и попробует остановиться снова. Живой прогон показал сценарий, где это предположение
 * ложно: F5-T2 была принята и закрыта lead-ом, но получила один и тот же вердикт 12 раз подряд —
 * файлы, названные нарушением, ей не принадлежали (F5-3, атрибуция ниже) и она не могла ни
 * откатить их (чужая работа), ни удовлетворить контроль. Выхода не было; обе сессии пришлось
 * останавливать извне.
 *
 * Фикс — `handleFailure`: причина блокировки детерминированно хешируется и сравнивается с ранее
 * показанной ЭТОЙ ЖЕ сессии (`session_id` из hook payload — единственное общее для всех hook-
 * событий поле, которое сессия не выбирает сама). Первое появление причины — блокировка как
 * раньше (`exit 2`), причина запоминается в state-файле вне репозитория (`os.tmpdir()`, не
 * write-path ни одной задачи — F5-2 обсуждает соседнюю проблему доступности САМОГО скрипта hook-а
 * на запись, но состояние здесь читает и пишет только сам hook-процесс, не через Write/Edit/Bash
 * агента, поэтому PreToolUse-слои к этому не применимы и не обходятся). Повтор ТОЙ ЖЕ причины для
 * ТОЙ ЖЕ сессии — эскалация уже состоялась один раз и не сработала; вторая попытка блокировки не
 * защищает, а только продлевает ловушку, поэтому сессии дают остановиться (`exit 0`), громко
 * отмечая это в stderr. Другая (новая) причина или другая сессия — блокировка происходит заново
 * с чистого листа.
 *
 * Это не решает F5-3 (атрибуция) — оно ограничивает вред от него: ложное срабатывание теперь
 * стоит сессии одного блока, а не бесконечного цикла, и итоговое решение всё равно остаётся за
 * отдельным, неблокирующим `pnpm ownership:check` (или человеком), а не за этим hook-ом.
 *
 * F5-3 (атрибуция, живой прогон) — в общем рабочем дереве (без per-session git worktree) diff от
 * anchor-коммита (B-1) физически не может отличить «эта task-сессия внесла это изменение» от
 * «lead или другая параллельная task-сессия закоммитили это в то же дерево, пока эта сессия ещё
 * работала»: git не хранит session_id коммита. Продемонстрировано: F5-T2/F5-T3 получили вердикт
 * о нарушении write set на `.github/workflows/ci.yml`/`CLAUDE.md`/`README.md` — файлах, которые
 * менял lead, а не они.
 *
 * Рассмотренная и ОТКЛОНЁННАЯ альтернатива — безусловно исключать совпадения с `leadPaths` из
 * нарушений для task-сессии: это симметрично СНИМАЕТ уже зафиксированную защиту N1 (второй раунд
 * верификации), потому что оба репро-файла N1 (`README.md`, `.claude/settings.autonomous.json`)
 * САМИ входят в `leadPaths` — контроль, снятый для «чужих» файлов, снят и для случая, когда
 * ЭТА task-сессия действительно записала в один из них. Без независимого способа отличить
 * «это чужой legitimate-коммит» от «это моя запись в чужой путь» смягчение одной проблемы
 * обязательно реоткрывает другую — здесь нет свободного параметра, которым можно было бы решить
 * обе одновременно средствами одного общего git-дерева.
 *
 * Вывод: корректная атрибуция в общем рабочем дереве без внешнего источника identity —
 * недостижима. Единственное честное решение — изоляция: каждая task-сессия работает в
 * собственном `git worktree`, тогда её diff от anchor-коммита И ЕСТЬ её работа, без всякой
 * эвристики. `PLAN.md` §8 (I00) уже фиксирует общий worktree как принятое отклонение итерации —
 * рекомендация этого раунда: закрыть его для I01, а не продолжать нести дальше. Это процессное
 * решение вне write set этой задачи (`docs/**`, `.claude/**` — lead paths); реализовано здесь
 * только ограничение вреда (F5-1), а не сама атрибуция.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findDiffViolations, formatViolations } from '../diff-violations.ts';
import { classifySession } from '../session-role.ts';
import { checkOwnership, formatOwnershipProblem } from '../task-ownership.ts';
import { loadTaskDeclarationsFromGit } from '../tasks-directory.ts';
import { loadWriteSetFromGit } from '../writeset.ts';
import { readHookInput } from './read-stdin.ts';

/** Ссылка, с которой читается СОДЕРЖИМОЕ control-файлов (что сейчас объявлено). Не путать с
 * базой для diff — см. `resolveLastCommitTouchingPath` и docstring файла (B-1). */
const DECLARATION_REF = 'HEAD';
const WRITESET_PATH = '.claude/writeset.json';
const TASKS_DIR = '.claude/tasks';

type GitTextResult =
  | { readonly kind: 'ok'; readonly stdout: string }
  | { readonly kind: 'error'; readonly reason: string };

/** minor 5: различает «git упал» от «git ничего не вернул» — раньше обе ветки давали []. */
const runGit = (projectRoot: string, args: readonly string[]): GitTextResult => {
  try {
    const stdout = execFileSync('git', [...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { kind: 'ok', stdout };
  } catch (error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    const reason =
      typeof stderr === 'string' && stderr.trim().length > 0 ? stderr.trim() : String(error);
    return { kind: 'error', reason };
  }
};

type GitListResult =
  | { readonly kind: 'ok'; readonly files: readonly string[] }
  | { readonly kind: 'error'; readonly reason: string };

const gitNameList = (projectRoot: string, args: readonly string[]): GitListResult => {
  const result = runGit(projectRoot, args);
  if (result.kind === 'error') return result;
  return {
    kind: 'ok',
    files: result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
};

type LastCommitResult =
  | { readonly kind: 'ok'; readonly commit: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly reason: string };

/** B-1: последний коммит, менявший `path`, среди предков `ref` (включительно). См. docstring
 * файла для полного обоснования и осознанно принятой границы этого подхода. */
const resolveLastCommitTouchingPath = (
  projectRoot: string,
  ref: string,
  path: string,
): LastCommitResult => {
  const result = runGit(projectRoot, ['log', '-1', '--format=%H', ref, '--', path]);
  if (result.kind === 'error') return result;
  const sha = result.stdout.trim();
  return sha.length === 0 ? { kind: 'absent' } : { kind: 'ok', commit: sha };
};

/** Изменённые файлы: diff от `baseCommit` + untracked. minor 5: ошибка git — явный fail. */
const changedFilesSince = (projectRoot: string, baseCommit: string): GitListResult => {
  const diff = gitNameList(projectRoot, ['diff', '--name-only', baseCommit]);
  if (diff.kind === 'error') return diff;
  const untracked = gitNameList(projectRoot, ['ls-files', '--others', '--exclude-standard']);
  if (untracked.kind === 'error') return untracked;
  return { kind: 'ok', files: [...new Set([...diff.files, ...untracked.files])] };
};

/** F5-1: каталог state-файлов эскалации — вне репозитория, читает/пишет только сам hook-процесс. */
const STATE_DIR = join(tmpdir(), 'agent-harness-subagent-stop-state');

/**
 * Сколько раз одна сессия может быть заблокирована SubagentStop-ом, суммарно по всем причинам.
 *
 * Не «один раз на причину» и не «без ограничения». Живой прогон I02A показал, почему граница
 * обязана быть на СЕССИИ: reviewer-сессия работала в общем дереве, lead продолжал править
 * файлы, список нарушений в тексте причины рос от каждой чужой правки — а значит каждый раз
 * давал «новую причину» и новую блокировку. Текст причины в общем дереве не свойство сессии,
 * а снимок чужой работы, поэтому дедуп по тексту не ограничивает ничего.
 *
 * Два, а не один: намерение F5-1 (I00) в том, что действительно НОВАЯ информация заслуживает
 * быть показанной, и одна повторная эскалация это сохраняет. Дальше сессия выпускается в любом
 * случае — причина при этом всегда называется, а итоговая сверка идёт неблокирующим
 * `pnpm ownership:check`.
 */
const MAX_ESCALATIONS_PER_SESSION = 2;

const stateFilePath = (projectRoot: string, sessionId: string): string => {
  const repoHash = createHash('sha256').update(projectRoot).digest('hex').slice(0, 20);
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 200);
  return join(STATE_DIR, `${repoHash}--${safeSessionId}.json`);
};

interface EscalationState {
  /** Хеш причины ПОСЛЕДНЕЙ блокировки: точный повтор той же причины эскалацией не считается. */
  readonly reasonHash: string;
  /** Сколько блокировок эта сессия уже получила; см. `MAX_ESCALATIONS_PER_SESSION`. */
  readonly escalations: number;
}

const readEscalationState = (path: string): EscalationState | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const record = parsed as {
      readonly reasonHash?: unknown;
      readonly escalations?: unknown;
    } | null;
    if (typeof record?.reasonHash !== 'string') return undefined;
    // Состояние прежнего формата (без счётчика) читается как одна состоявшаяся эскалация:
    // сессия, начатая до обновления хука, не должна получить лишнюю блокировку.
    const escalations = typeof record.escalations === 'number' ? record.escalations : 1;
    return { reasonHash: record.reasonHash, escalations };
  } catch {
    return undefined;
  }
};

const writeEscalationState = (path: string, state: EscalationState): void => {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch {
    // Best-effort: если состояние недоступно для записи, следующий вызов просто снова
    // заблокирует один раз — деградация в сторону большей строгости (блокирует), не fail-open.
  }
};

const clearState = (path: string): void => {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort — см. writeEscalationState.
  }
};

/**
 * F5-1: блокирует (`exit 2`) не более {@link MAX_ESCALATIONS_PER_SESSION} раз на сессию,
 * после чего пропускает (`exit 0`), обязательно назвав причину.
 *
 * Учёт ведётся по (сессия, причина): точный повтор той же причины эскалацией не считается —
 * она уже состоялась и не помогла. Новая причина расходует одну оставшуюся эскалацию, а не
 * открывает бесконечный счёт: см. рассуждение у {@link MAX_ESCALATIONS_PER_SESSION}.
 *
 * Состояние очищается только при действительно чистом завершении без единой причины
 * (см. конец `main`).
 *
 * Без `session_id` в payload учёт невозможен — тогда безопасное направление отказа прежнее:
 * блокировать безусловно.
 */
const handleFailure = (
  sessionId: string | undefined,
  projectRoot: string,
  reason: string,
): void => {
  if (sessionId === undefined) {
    process.stderr.write(`${reason}\n`);
    process.exit(2);
  }

  const path = stateFilePath(projectRoot, sessionId);
  const reasonHash = createHash('sha256').update(reason).digest('hex');
  const previous = readEscalationState(path);

  const sameReason = previous?.reasonHash === reasonHash;
  const escalations = previous?.escalations ?? 0;

  if (sameReason || escalations >= MAX_ESCALATIONS_PER_SESSION) {
    process.stderr.write(
      `${reason}\n\n` +
        `[F5-1] Эскалация для этой сессии (session_id=${sessionId}) исчерпана: ` +
        `${String(escalations)} из ${String(MAX_ESCALATIONS_PER_SESSION)}` +
        (sameReason ? ', и эта причина уже показывалась' : '') +
        '. Повторная блокировка не защищает, а держит сессию в ловушке без выхода (живые ' +
        'прогоны I00-F5 и I02A). Причина выше названа и остаётся в силе — остановка разрешена, ' +
        'итоговая сверка через неблокирующий `pnpm ownership:check` или human review.\n',
    );
    return;
  }

  writeEscalationState(path, { reasonHash, escalations: escalations + 1 });
  process.stderr.write(`${reason}\n`);
  process.exit(2);
};

/** Общее сообщение для «база сравнения для control-файла нерезолвима» (B-1, fail-closed). */
const baseResolutionFailure = (path: string, ref: string, result: LastCommitResult): string =>
  result.kind === 'error'
    ? `Fail-closed: не удалось определить базу сравнения для ${path}: ${result.reason}`
    : `Fail-closed: ${path} присутствует на ${ref}, но история не содержит коммита, который бы ` +
      'его вводил — база сравнения (B-1) нерезолвима.';

/** F5-1 (диагностика, п.3): контекст «какая сессия и какой диапазон проверялись», чтобы получатель
 * мог отличить своё нарушение от чужого (F5-3) без повторного запуска git самостоятельно. */
const diagnosticContext = (sessionId: string | undefined, baseCommit: string): string =>
  `[SubagentStop session_id=${sessionId ?? 'unknown'} range=${baseCommit}..HEAD]`;

/**
 * Тело проверки — синхронная функция, а не встроенная в `main`, специально ради F5-1: `main`
 * обязан выполнить cleanup ПОСЛЕ этой функции на любом её выходе (включая ранние `return`), а
 * досрочный `return` изнутри самого `main` пропустил бы этот cleanup на части путей.
 */
const runChecks = (
  input: Readonly<Record<string, unknown>>,
  projectRoot: string,
  sessionId: string | undefined,
  fail: (reason: string) => void,
): void => {
  const sessionRole = classifySession(input);

  // Роль из payload нужна файлу с несколькими задачами (I02B): параллельные исполнители делят
  // один объявленный write set и выбирают свою запись по роли.
  const ownerRole = typeof input['agent_type'] === 'string' ? input['agent_type'] : undefined;
  const writeSetAtHead = loadWriteSetFromGit(
    projectRoot,
    DECLARATION_REF,
    WRITESET_PATH,
    ownerRole,
  );
  if (writeSetAtHead.kind === 'invalid') {
    fail(
      `Fail-closed: .claude/writeset.json недоступен из git-объекта ${DECLARATION_REF}: ${writeSetAtHead.reason}`,
    );
    return;
  }

  const tasksAtHead = loadTaskDeclarationsFromGit(projectRoot, DECLARATION_REF, TASKS_DIR);
  if (tasksAtHead.kind === 'invalid') {
    fail(
      `Fail-closed: .claude/tasks/*.json недоступна из git-объекта ${DECLARATION_REF}: ${tasksAtHead.reason}`,
    );
    return;
  }

  const declarationPresent = writeSetAtHead.kind === 'task' || tasksAtHead.kind === 'loaded';

  if (sessionRole === 'lead') {
    // M-2: см. docstring файла. Отсутствие сигнала роли при УЖЕ объявленном write set — не
    // доказательство lead-сессии, а потенциальная потеря дискриминатора; fail-closed.
    if (declarationPresent) {
      fail(
        [
          'Fail-closed (M-2, раунд 3 верификации): SubagentStop сработал без agent_id/agent_type',
          `в payload (роль классифицирована как lead), но в git-объекте ${DECLARATION_REF} уже`,
          'объявлен write set (.claude/writeset.json и/или .claude/tasks/*.json). SubagentStop',
          'штатно происходит только при завершении subagent-сессии — совпадение «есть объявленная',
          'задача» и «нет сигнала роли» не доказывает lead-сессию, поэтому не открывает write set.',
          'Если это действительно lead-сессия (например, событие ошибочно сработало для',
          'main-потока) — расследуйте вручную; источник читается из git-объекта, поэтому удаление',
          'или подмена control-файла в рабочем дереве эту проверку не обходит.',
        ].join(' '),
      );
      return;
    }
    return; // backward-compat: без объявленного write set lead-сессия не ограничена.
  }

  // Дальше — sessionRole === 'task'.

  if (writeSetAtHead.kind === 'task') {
    const base = resolveLastCommitTouchingPath(projectRoot, DECLARATION_REF, WRITESET_PATH);
    if (base.kind !== 'ok') {
      fail(baseResolutionFailure(WRITESET_PATH, DECLARATION_REF, base));
      return;
    }
    const changed = changedFilesSince(projectRoot, base.commit);
    if (changed.kind === 'error') {
      fail(`Fail-closed: git diff завершился ошибкой: ${changed.reason}`);
      return;
    }
    const violations = findDiffViolations(changed.files, writeSetAtHead.writeSet);
    if (violations.length > 0) {
      fail(
        `${diagnosticContext(sessionId, base.commit)}\n` +
          formatViolations(violations, writeSetAtHead.writeSet.task_id),
      );
    }
    return;
  }

  // writeSetAtHead.kind === 'lead' (.claude/writeset.json отсутствует на DECLARATION_REF):
  // fallback на карту задач итерации.
  if (tasksAtHead.kind === 'absent') {
    fail(
      'Task-сессия завершается без .claude/writeset.json и без .claude/tasks/*.json: ' +
        'нет объявленного источника write set. Lead обязан объявить write set до запуска задачи ' +
        '(это не пропуск проверки: отсутствие обоих источников — fail-closed).',
    );
    return;
  }

  const base = resolveLastCommitTouchingPath(projectRoot, DECLARATION_REF, TASKS_DIR);
  if (base.kind !== 'ok') {
    fail(baseResolutionFailure(TASKS_DIR, DECLARATION_REF, base));
    return;
  }
  const changed = changedFilesSince(projectRoot, base.commit);
  if (changed.kind === 'error') {
    fail(`Fail-closed: git diff завершился ошибкой: ${changed.reason}`);
    return;
  }

  // N1: leadPaths здесь не дают владения — только фиксируют нарушение (см. checkOwnership doc).
  const report = checkOwnership(
    changed.files,
    tasksAtHead.tasks,
    tasksAtHead.leadPaths,
    'task-session',
  );
  if (report.problems.length > 0) {
    const lines = report.problems.map((problem) => `  - ${formatOwnershipProblem(problem)}`);
    fail(
      [
        `${diagnosticContext(sessionId, base.commit)}`,
        'Task-сессия изменила файлы вне карты владения задачами итерации (.claude/tasks/*.json):',
        ...lines,
      ].join('\n'),
    );
  }
};

const main = async (): Promise<void> => {
  const input = await readHookInput();
  const projectRoot =
    typeof input['cwd'] === 'string' && input['cwd'].length > 0 ? input['cwd'] : process.cwd();
  const sessionId =
    typeof input['session_id'] === 'string' && input['session_id'].length > 0
      ? input['session_id']
      : undefined;

  let failed = false;
  const fail = (reason: string): void => {
    failed = true;
    handleFailure(sessionId, projectRoot, reason);
  };

  runChecks(input, projectRoot, sessionId, fail);

  // F5-1: завершение без единой причины — любое ранее сохранённое состояние эскалации для этой
  // сессии больше не актуально. Очищаем, чтобы НОВАЯ, отличающаяся причина в будущем снова
  // блокировала один раз, а не молча пропускалась как «уже видели» устаревшим состоянием.
  if (!failed && sessionId !== undefined) {
    clearState(stateFilePath(projectRoot, sessionId));
  }
};

await main();
