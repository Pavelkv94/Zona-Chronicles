/**
 * I06-D — летопись читается именами мира, а не его идентификаторами (PLAN §10 D).
 *
 * Итерация про ВЫБОР ДОРОГИ, и до неё лента могла его не называть: пока путь начинал человек,
 * зритель знал маршрут из своей же команды. Теперь дорогу выбирает агент, и строка «вышел в
 * путь» без дороги скрывает ровно то единственное, ради чего итерация затевалась.
 *
 * Проверяется прочтение факта, а не разметка: `describeEvent` — чистая функция от события и
 * названий мира, поэтому её можно проверить без браузера. Именно она, а не React, решает, что
 * зритель прочитает.
 */
import { describe, expect, it } from 'vitest';
import type { ObserverEvent, ObserverWorldSnapshot } from '@zona/contracts';
import { describeEvent, namingOf } from './observer-language.ts';

const SNAPSHOT: ObserverWorldSnapshot = {
  world_id: 'world:prototype',
  projection_sequence: 0,
  world_time: '2028-04-26T06:00:00.000Z',
  nodes: [
    { location_id: 'loc:bridge', name: 'Мост', description: 'Полуразрушенный мост.' },
    { location_id: 'loc:checkpoint', name: 'Блокпост', description: 'Бетонные блоки.' },
  ],
  edges: [
    {
      route_id: 'route:bridge-to-checkpoint',
      from_location_id: 'loc:bridge',
      to_location_id: 'loc:checkpoint',
      travel_minutes: 25,
    },
  ],
  agents: [
    {
      agent_id: 'agent:finch',
      name: 'Зяблик',
      location_id: 'loc:bridge',
      route_id: null,
      status: 'idle',
      needs: { hunger: 'normal', fatigue: 'normal' },
      food_carried: 2,
      goal: 'idle',
    },
  ],
};

const naming = namingOf(SNAPSHOT);

const event = (patch: Partial<ObserverEvent>): ObserverEvent => ({
  projection_sequence: 1,
  event_id: 'evt_00000000000000000000000000',
  world_time: '2028-04-26T13:12:00.000Z',
  type: 'journey.started',
  actor_ids: ['agent:finch'],
  location_id: 'loc:bridge',
  route_id: 'route:bridge-to-checkpoint',
  need: null,
  need_level: null,
  goal: null,
  ...patch,
});

describe('I06-D — прочтение факта зрителем', () => {
  it('уход называет дорогу, по которой агент ушёл', () => {
    // Без этого «Зяблик вышел в путь» одинаково читается для обеих дорог из моста — то есть не
    // говорит ничего именно о том, что выбрал агент.
    expect(describeEvent(event({}), naming)).toBe('Зяблик вышел в путь: Мост → Блокпост');
  });

  it('разведка называет дорогу, а не место', () => {
    expect(describeEvent(event({ type: 'risk.observed' }), naming)).toBe(
      'Зяблик разведал дорогу: Мост → Блокпост',
    );
  });

  it('опасность дороги в строке не появляется', () => {
    // STOP-условие итерации в его экранной части: зритель видит, что разведка была, но не
    // узнаёт вместе с агентом ни числа, ни слова о том, насколько там скверно.
    const line = describeEvent(event({ type: 'risk.observed' }), naming);
    expect(line).not.toMatch(/\d/);
    expect(line.toLowerCase()).not.toContain('опас');
  });

  it('решение уйти читается именем агента и названием места', () => {
    expect(describeEvent(event({ type: 'goal.chosen', goal: 'flee' }), naming)).toBe(
      'Зяблик решил уйти отсюда — Мост',
    );
  });

  it('прибытие называет место, а не дорогу', () => {
    expect(
      describeEvent(event({ type: 'journey.completed', location_id: 'loc:checkpoint' }), naming),
    ).toBe('Зяблик дошёл — Блокпост');
  });

  it('состояние читается нуждой и её уровнем', () => {
    expect(
      describeEvent(
        event({ type: 'need.threshold.crossed', need: 'fatigue', need_level: 'warning' }),
        naming,
      ),
    ).toBe('Зяблик: устал — Мост');
  });

  it('незнакомый мир называется своими идентификаторами, а не выдуманным именем', () => {
    // Проекция могла быть собрана из другого мира: показать «неизвестный» значило бы скрыть
    // расхождение, а придумать имя — соврать. Идентификатор — это правда, которая есть.
    const empty = namingOf(null);
    expect(describeEvent(event({}), empty)).toBe(
      'agent:finch вышел в путь: route:bridge-to-checkpoint',
    );
  });
});
