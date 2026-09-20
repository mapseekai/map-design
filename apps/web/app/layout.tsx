import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { I18nProvider } from '../src/i18n';
import '../src/index.css';

export const metadata: Metadata = {
  title: 'MapDesign',
  icons: {
    icon: '/map-design.svg',
    apple: '/map-design.svg',
  },
};

export const viewport: Viewport = {
  themeColor: '#faf9f5',
};

// The shared DESIGN.md palette is fixed; legacy stored accents must not override it.
const themeInitScript = "document.documentElement.setAttribute('data-theme','light');";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='en' suppressHydrationWarning>
      {/* eslint-disable-next-line @next/next/no-sync-scripts */}
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: intentional theme-init inline script to prevent FOUC */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body suppressHydrationWarning>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
