import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { consumeConnectCallbackFromUrl } from './lib/connectCallback';
import './styles.css';

// Before the first render, and deliberately so — see the function's own
// comment for the two ordering bugs that put it here rather than in an
// effect. After this line the address bar is `/` and the OAuth result, if
// there was one, is waiting in sessionStorage.
consumeConnectCallbackFromUrl();

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
