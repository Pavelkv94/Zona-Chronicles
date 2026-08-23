import type { NextConfig } from 'next';

/**
 * Экран наблюдателя (I03).
 *
 * `output: 'standalone'` не нужен: продукт пока запускается локально, а лишняя сборочная
 * конфигурация — это то, что потом никто не решается тронуть. Появится вместе с I17.
 */
const config: NextConfig = {
  reactStrictMode: true,
  // Адрес observer API. Единственная настройка экрана: он больше НИЧЕГО не знает о мире и не
  // может знать — канонических таблиц для него не существует ни в типах, ни в правах.
  env: {
    ZONA_API_BASE_URL: process.env['ZONA_API_BASE_URL'] ?? 'http://localhost:3001',
  },
};

export default config;
