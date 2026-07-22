/**
 * Entry point for the development-only states preview (#245).
 *
 * Deliberately does NOT import `firebase.ts` or `config.ts` — the preview
 * renders fixtures and makes no authenticated call, so it runs without a
 * Firebase API key in the environment. That is what makes it usable as a
 * design-review surface on a fresh clone.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { StatesPreview } from './StatesPreview';
import '../styles.css';
import './preview.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <StatesPreview />
  </StrictMode>,
);
