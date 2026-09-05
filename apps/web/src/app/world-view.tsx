'use client';

/**
 * Экран наблюдателя: карта узлов и лента событий (I03, D11/D13).
 *
 * ## Состояние восстанавливается snapshot-ом, а не историей потока
 *
 * При загрузке страницы и при каждом обновлении экран читает `GET /v1/world/snapshot` — он
 * самодостаточен. SSE только ДОБАВЛЯЕТ события, приходящие дальше. Это OPS-02 и D11: отключение
 * потока целиком оставляет страницу работоспособной, просто перестающей обновляться, а
 * перезагрузка восстанавливает актуальный мир без всякой ленты.
 *
 * Обратный порядок — «состояние собирается проигрыванием потока с начала» — был бы проще в коде и
 * неверен: он требует непрерывной истории с нуля, то есть ломается ровно тогда, когда мир прожил
 * достаточно долго, чтобы окно retention его не вмещало.
 *
 * ## Экран не влияет на мир
 *
 * Ни одного запроса, меняющего мир, здесь нет и быть не может: write-маршрутов в публичном API не
 * существует (D4). Открытая вкладка, десять вкладок или ноль — журнал одинаков (D3).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';
import { OBSERVER_STREAM_EVENT_NAMES } from '@zona/contracts';
import { fetchEvents, fetchSnapshot } from './observer-client.ts';
import { describeCondition, describeEvent, namingOf } from './observer-language.ts';

/** Сколько последних событий держит лента на экране. Не окно retention — просто читаемость. */
const FEED_LIMIT = 40;

const worldClock = (iso: string): string => iso.replace('T', ' ').replace('.000Z', '');

export interface WorldViewProps {
  /** Адрес observer API. Приходит с сервера при запросе — см. `page.tsx`. */
  readonly apiBaseUrl: string;
}

export function WorldView({ apiBaseUrl }: WorldViewProps) {
  const [snapshot, setSnapshot] = useState<ObserverWorldSnapshot | null>(null);
  const [feed, setFeed] = useState<readonly ObserverEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [streamLive, setStreamLive] = useState(false);
  const cursor = useRef(0);

  /**
   * Полное восстановление: карта, агенты и лента до текущего курсора.
   *
   * ПОРЯДОК ВАЖЕН, и это не стилистика. Курсор выставляется ДО `setSnapshot`, потому что
   * `setSnapshot` будит эффект, открывающий поток, и тот читает `cursor.current`. Первая
   * редакция ставила курсор последней строкой — после `await fetchEvents`, — и React успевал
   * открыть поток с нулевой позиции: лента приходила второй раз, а на экране события двоились.
   * Найдено живым прогоном, не тестом: курсор показывал 2, а записей было четыре.
   */
  const restore = useCallback(async () => {
    try {
      const loaded = await fetchSnapshot(apiBaseUrl);
      if (loaded === null) {
        setSnapshot(null);
        setError('Мир ещё не создан или проекция не собрана.');
        return;
      }
      cursor.current = loaded.projection_sequence;
      const from = Math.max(0, loaded.projection_sequence - FEED_LIMIT);
      const page = await fetchEvents(apiBaseUrl, from, FEED_LIMIT);
      setFeed(page.events);
      setError(null);
      setSnapshot(loaded);
    } catch (cause) {
      setError(`observer API недоступен: ${String(cause)}`);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    void restore();
  }, [restore]);

  useEffect(() => {
    if (snapshot === null) return undefined;

    const source = new EventSource(
      `${apiBaseUrl}/v1/stream?last_event_id=${String(cursor.current)}`,
    );
    source.addEventListener('open', () => setStreamLive(true));

    source.addEventListener(OBSERVER_STREAM_EVENT_NAMES.event, (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as ObserverEvent;
      cursor.current = Math.max(cursor.current, event.projection_sequence);
      setFeed((current) =>
        // Защита от повтора вторым слоем: курсор проекции уникален, поэтому дубль здесь означает
        // не «событие случилось дважды», а что мы получили его дважды. Показать его дважды —
        // соврать зрителю о мире.
        current.some((seen) => seen.projection_sequence === event.projection_sequence)
          ? current
          : [...current, event].slice(-FEED_LIMIT),
      );
      // Позиция агентов меняется событиями, но карта берётся из snapshot: перечитываем его, а не
      // повторяем свёртку на клиенте. Вторая реализация свёртки разошлась бы с первой молча.
      void fetchSnapshot(apiBaseUrl)
        .then(setSnapshot)
        .catch(() => undefined);
    });

    source.addEventListener(OBSERVER_STREAM_EVENT_NAMES.reset, () => {
      // Окно retention потеряно: перечитываем snapshot, а не догадываемся о пропущенном (D10).
      source.close();
      setStreamLive(false);
      void restore();
    });

    source.addEventListener('error', () => setStreamLive(false));

    return () => {
      source.close();
      setStreamLive(false);
    };
  }, [snapshot === null, restore, apiBaseUrl]);

  if (error !== null && snapshot === null) {
    return (
      <main className="shell">
        <section className="panel">
          <h2>Мир</h2>
          <div className="notice">{error}</div>
        </section>
      </main>
    );
  }

  const naming = namingOf(snapshot);

  const agentsAt = (locationId: string) =>
    (snapshot?.agents ?? []).filter((agent) => agent.location_id === locationId);
  const traveling = (snapshot?.agents ?? []).filter((agent) => agent.status === 'traveling');

  return (
    <main className="shell">
      <section className="panel">
        <h2>Карта мира</h2>
        <div className="status">
          <span>
            Мировое время: <b>{snapshot === null ? '—' : worldClock(snapshot.world_time)}</b>
          </span>
          <span>
            Курсор проекции: <b>{snapshot?.projection_sequence ?? '—'}</b>
          </span>
          <span>
            Поток: <b>{streamLive ? 'живой' : 'нет'}</b>
          </span>
        </div>
        {error !== null && <div className="notice">{error}</div>}

        {(snapshot?.nodes ?? []).map((node) => (
          <div className="node" key={node.location_id}>
            <div className="node-name">{node.name}</div>
            <div className="node-desc">{node.description}</div>
            <div className="node-agents">
              {agentsAt(node.location_id).map((agent) => (
                <span className="agent" key={agent.agent_id}>
                  {agent.name} <span className="agent-condition">{describeCondition(agent)}</span>
                </span>
              ))}
              {agentsAt(node.location_id).length === 0 && <span className="node-desc">пусто</span>}
            </div>
          </div>
        ))}

        {traveling.length > 0 && (
          <div className="node">
            <div className="node-name">В пути</div>
            <div className="node-agents">
              {traveling.map((agent) => (
                <span className="agent agent-traveling" key={agent.agent_id}>
                  {agent.name} → {agent.route_id === null ? '—' : naming.route(agent.route_id)}{' '}
                  <span className="agent-condition">{describeCondition(agent)}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <div className="edges">
          Маршруты:
          {(snapshot?.edges ?? []).map((edge) => (
            <div key={edge.route_id}>
              {naming.location(edge.from_location_id)} → {naming.location(edge.to_location_id)} (
              {edge.travel_minutes} мин)
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h2>Лента событий</h2>
        <ul className="feed">
          {feed.map((event) => (
            <li key={event.event_id}>
              <span className="feed-time">{worldClock(event.world_time)}</span>{' '}
              <span className="feed-type">{event.type}</span>
              <div>{describeEvent(event, naming)}</div>
            </li>
          ))}
          {feed.length === 0 && <li className="node-desc">Пока ничего не произошло.</li>}
        </ul>
      </section>
    </main>
  );
}
