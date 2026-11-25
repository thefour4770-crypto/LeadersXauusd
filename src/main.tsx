import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import './index.css';

const hadController =
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator &&
  Boolean(navigator.serviceWorker.controller);
let controllerReloadTriggered = false;

if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator && hadController) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (controllerReloadTriggered) return;
    controllerReloadTriggered = true;
    window.location.reload();
  });
}

const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    void updateSW(true);
  },
  onRegisterError() {
    // Non-fatal in preview iframes or restricted browsers
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    window.setInterval(() => {
      if (!document.hidden) {
        void registration.update().catch(() => {});
      }
    }, 60_000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void registration.update().catch(() => {});
      }
    });
  },
});

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}
