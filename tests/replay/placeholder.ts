/**
 * Заглушка, удерживающая `tests/` внутри TypeScript-проекта.
 *
 * Без единого `.ts` файла `tests/tsconfig.json` падает с TS18003, а без tsconfig
 * первый же acceptance/replay-тест I02A валит `pnpm lint` с "not found by the project service".
 * Файл не является тестом и удаляется, когда в I02B появится настоящий replay-набор.
 */
export const REPLAY_SUITE_OWNER_ITERATION = 'I02B' as const;
