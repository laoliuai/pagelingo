import { createRoot } from 'react-dom/client';
import { Providers } from './app/providers';
import { SessionProvider } from './app/session';
import { Router } from './app/router';
import './shared/styles/globals.css';
try {
  const theme = localStorage.getItem('pgl-theme');
  document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}
createRoot(document.getElementById('root')!).render(
  <Providers>
    <SessionProvider>
      <Router />
    </SessionProvider>
  </Providers>,
);
