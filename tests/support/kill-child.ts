/**
 * Убивает дочерний процесс и дожидается его завершения — БЕЗ зависания на уже мёртвом.
 *
 * Наивная форма `child.kill('SIGKILL'); await new Promise((r) => child.once('exit', r))` виснет
 * НАВСЕГДА, если процесс завершился раньше: событие `exit` уже произошло, а подписка на него
 * оформлена после. В тесте это выглядит не как падение, а как молчание до таймаута — и потому
 * особенно дорого: мутационная проба, которую тест обязан ловить за 60 секунд, «ловилась» за 180
 * по срабатыванию таймаута, то есть по другой причине.
 *
 * Тот же класс, что записан в правилах проекта: тест обязан ПАДАТЬ, а не виснуть. Проверка
 * `exitCode`/`signalCode` отличает «ещё жив» от «уже вышел» синхронно и без гонки.
 */
import type { ChildProcess } from 'node:child_process';

export const killAndWait = async (
  child: ChildProcess,
  signal: NodeJS.Signals = 'SIGKILL',
): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill(signal);
  await exited;
};
