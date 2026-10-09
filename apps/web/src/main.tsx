import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { AppErrorBoundary } from './AppErrorBoundary.js';
import './styles.css';

import { CompanionApp } from './features/companion/CompanionApp.js';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('The application root was not found.');
}

const isCompanion = window.location.pathname.startsWith('/companion');

createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>{isCompanion ? <CompanionApp /> : <App />}</AppErrorBoundary>
  </StrictMode>,
);
