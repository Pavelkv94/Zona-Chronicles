import { API_BASE_URL } from '../config.ts';
import { WorldView } from './world-view.tsx';

/**
 * Страница рендерится НА КАЖДЫЙ ЗАПРОС, а не собирается заранее.
 *
 * Иначе адрес observer API был бы зафиксирован в момент сборки, и один и тот же собранный экран
 * нельзя было бы направить на другой мир — ровно это и обнаружил E2E-сценарий.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return <WorldView apiBaseUrl={API_BASE_URL} />;
}
