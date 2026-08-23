/**
 * Клиент observer API (I03).
 *
 * Экран знает ровно два адреса и ни одного факта о мире помимо того, что они отдают. Ни
 * канонических таблиц, ни команд: типы приходят из `@zona/contracts`, где публичный контракт и
 * объявлен, а write-маршрутов в API не существует вовсе (D4).
 */
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';
import { API_BASE_URL } from '../config.ts';

export const apiBaseUrl = (): string => API_BASE_URL;

export interface ObserverEventPage {
  readonly events: readonly ObserverEvent[];
  readonly earliest_available_sequence: number | null;
}

export const fetchSnapshot = async (): Promise<ObserverWorldSnapshot | null> => {
  const response = await fetch(`${apiBaseUrl()}/v1/world/snapshot`, { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`observer API: snapshot вернул ${String(response.status)}`);
  return (await response.json()) as ObserverWorldSnapshot;
};

export const fetchEvents = async (after: number, limit = 50): Promise<ObserverEventPage> => {
  const url = `${apiBaseUrl()}/v1/events?after=${String(after)}&limit=${String(limit)}`;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`observer API: events вернул ${String(response.status)}`);
  return (await response.json()) as ObserverEventPage;
};
