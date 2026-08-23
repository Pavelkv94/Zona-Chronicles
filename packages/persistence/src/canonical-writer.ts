/**
 * Шлюз квалификации канонического писателя (I03, M-C).
 *
 * ## Что закрывает
 *
 * Проверка профиля выполнения (M3 аудита I02B) стоит на ЧТЕНИИ снимка. Мир при этом изменяет
 * `executeCommand`, который снимков не читает: процесс с неквалифицированным профилем
 * беспрепятственно дописывал канонические события, а `world replay` — единственный детектор
 * расхождения детерминизма — именно в этот момент переставал запускаться. Детектор выключался
 * ровно тогда, когда он нужен.
 *
 * ## Гранулярность: ОДИН РАЗ НА ПРОЦЕСС, а не на команду
 *
 * Профиль — свойство процесса, а не команды: он не меняется между двумя `executeCommand` внутри
 * одного запуска. Проверять его на каждой команде значило бы протащить обязательный параметр
 * через 79 мест вызова, включая тесты, и добавить чтение к каждой транзакции — ради значения,
 * которое заведомо то же самое.
 *
 * **Остаточный риск записан честно, а не спрятан:** это шлюз, а не замок. Код, который откроет
 * соединение и вызовет `executeCommand`, не пройдя через `qualifyCanonicalWriter`, останется
 * непроверенным. Сегодня писателей ровно два — `apps/worker` и `apps/cli`, — и оба вызывают шлюз
 * при старте; тест это фиксирует. Настоящий замок (обязательный токен в сигнатуре
 * `executeCommand`) вынесен требованием в I04: он оправдан, когда писателей станет больше двух.
 */
import {
  isValidationFailure,
  verifyRuntimeProfileCompatibility,
  type DeterministicRuntimeProfile,
} from '@zona/contracts';
import type { DatabaseConnection } from './database.ts';

/** Мир не квалифицирован для профиля этого процесса — писать канонические события нельзя. */
export class UnqualifiedCanonicalWriterError extends Error {
  readonly code = 'UNQUALIFIED_CANONICAL_WRITER';

  constructor(message: string) {
    super(message);
    this.name = 'UnqualifiedCanonicalWriterError';
  }
}

/**
 * Записывает профиль как квалифицированный для мира. Вызывается ОДИН РАЗ, при создании мира.
 *
 * Отдельная функция, а не побочный эффект первого писателя: «кто первый пришёл, тот и
 * квалифицировал» означало бы, что контроль подтверждает сам себя.
 */
export const setWorldQualifiedProfile = async (
  db: DatabaseConnection,
  worldId: string,
  profile: DeterministicRuntimeProfile,
): Promise<void> => {
  await db
    .updateTable('worlds')
    .set({ qualified_runtime_profile: JSON.stringify(profile) })
    .where('world_id', '=', worldId)
    .execute();
};

/**
 * Проверяет, что процесс с профилем `candidate` имеет право изменять мир.
 *
 * Отказы РАЗНЫЕ по смыслу и потому различимы:
 *
 * - мира нет — обычная ошибка вызывающего;
 * - профиль мира не записан (`null`) — мир создан до контроля; писать нельзя, потому что
 *   сравнить не с чем, а «сравнить не с чем» это не «всё в порядке»;
 * - профиль несовместим — §7: «не квалифицирован», а не «сломан».
 */
export const qualifyCanonicalWriter = async (
  db: DatabaseConnection,
  worldId: string,
  candidate: DeterministicRuntimeProfile,
): Promise<void> => {
  const row = await db
    .selectFrom('worlds')
    .select('qualified_runtime_profile')
    .where('world_id', '=', worldId)
    .executeTakeFirst();

  if (row === undefined) {
    throw new UnqualifiedCanonicalWriterError(
      `persistence: мир ${worldId} не существует — квалифицировать писателя не для чего.`,
    );
  }
  if (row.qualified_runtime_profile === null || row.qualified_runtime_profile === undefined) {
    throw new UnqualifiedCanonicalWriterError(
      `persistence: у мира ${worldId} не записан квалифицированный профиль выполнения. Мир создан ` +
        'до этого контроля и не имел генезисного снимка, из которого профиль можно было бы ' +
        'восстановить (миграция 0012). Сравнивать не с чем, а «не с чем сравнить» — это не ' +
        '«всё в порядке»: пересоздайте мир либо запишите профиль явно.',
    );
  }

  const qualified = row.qualified_runtime_profile as DeterministicRuntimeProfile;
  const compatible = verifyRuntimeProfileCompatibility(qualified, candidate);
  if (isValidationFailure(compatible)) {
    throw new UnqualifiedCanonicalWriterError(
      `persistence: процесс не квалифицирован для мира ${worldId}: ` +
        `${compatible.errors.map((issue) => `${issue.path} ${issue.message}`).join('; ')}. ` +
        'Пока профиль не квалифицирован (§7), писать канонические события нельзя: они окажутся ' +
        'невоспроизводимыми, и обнаружилось бы это только расхождением replay — то есть сильно ' +
        'позже причины.',
    );
  }
};
