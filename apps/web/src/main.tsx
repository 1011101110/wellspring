import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { consumeConnectCallbackFromUrl } from './lib/connectCallback';
import { consumeYouVersionCallbackFromUrl } from './lib/youversionCallback';
import './styles.css';

// Before the first render, and deliberately so — see each function's own
// comment for the ordering bugs that put them here rather than in an effect.
// After these lines the address bar is `/` and the OAuth result, if there was
// one, is waiting in sessionStorage. The two callbacks use different query
// keys (`status` vs `youversion`) and different sessionStorage keys, so
// running both is safe: at most one has anything to consume.
consumeConnectCallbackFromUrl();
consumeYouVersionCallbackFromUrl();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
