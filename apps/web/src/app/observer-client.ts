/**
 * Клиент observer API (I03).
 *
 * Базовый адрес приходит ПАРАМЕТРОМ, а не читается из окружения: значение окружения Next
 * подставил бы в браузерный бандл на сборке, и собранный экран нельзя было бы направить на
 * другой мир. Читает его сервер при запросе (`page.tsx`).
 *
 * Экран знает ровно два адреса и ни одного факта о мире помимо того, что они отдают. Ни
 * канонических таблиц, ни команд: типы приходят из `@zona/contracts`, где публичный контракт и
 * объявлен, а write-маршрутов в API не существует вовсе (D4).
 */
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';

export interface ObserverEventPage {
  readonly events: readonly ObserverEvent[];
  readonly earliest_available_sequence: number | null;
}

export const fetchSnapshot = async (apiBaseUrl: string): Promise<ObserverWorldSnapshot | null> => {
  const response = await fetch(`${apiBaseUrl}/v1/world/snapshot`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`observer API: snapshot вернул ${String(response.status)}`);
  return (await response.json()) as ObserverWorldSnapshot;
};

export const fetchEvents = async (
  apiBaseUrl: string,
  after: number,
  limit = 50,
): Promise<ObserverEventPage> => {
  const url = `${apiBaseUrl}/v1/events?after=${String(after)}&limit=${String(limit)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`observer API: events вернул ${String(response.status)}`);
  return (await response.json()) as ObserverEventPage;
};
