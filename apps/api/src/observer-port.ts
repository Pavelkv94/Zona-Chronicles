/**
 * Что observer API умеет спросить у проекции — и ничего сверх этого (I03).
 *
 * Порт, а не прямой импорт хранилища, по двум причинам, и обе про границы, а не про удобство
 * тестов.
 *
 * Первая: этот интерфейс — исчерпывающий список того, что публичный путь МОЖЕТ узнать о мире.
 * Он умещается на экран, и добавление сюда метода — заметное изменение, а не деталь реализации
 * очередного маршрута. Прямой импорт `@zona/projections` дал бы API весь пакет целиком, включая
 * writer-ы, и запрет на запись держался бы только на грантах.
 *
 * Вторая: порт не даёт ни одного способа спросить о каноническом мире. Даже если однажды в
 * `@zona/projections` появится что-то каноническое (не должно, но правило обязано пережить
 * ошибку), API этого не увидит.
 */
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';

export interface ObserverEventPage {
  readonly events: readonly ObserverEvent[];
  /** Самая ранняя доступная позиция ленты; `null` — событий пока нет вовсе. */
  readonly earliestAvailableSequence: number | null;
}

export interface ObserverPort {
  readonly loadSnapshot: (worldId: string) => Promise<ObserverWorldSnapshot | null>;
  readonly loadEvents: (
    worldId: string,
    options: { readonly after: number; readonly limit: number },
  ) => Promise<ObserverEventPage>;
}
