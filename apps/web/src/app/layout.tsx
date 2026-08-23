import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Живая Зона — наблюдатель',
  description: 'Мир идёт сам. Зритель наблюдает и не вмешивается.',
};

export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
