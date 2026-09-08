import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readToken } from '../../fragment.js';
import { createStore } from '../../store.js';
import '../../styles/base.css';
import { EchoApp } from './echo-app.tsx';
import './echo.css';

/**
 * `dev.html` dev page: agent loop demo against a live server. The token is in a URL
 * fragment, like on the home page. Vite dev proxies `/api` requests to the running Sherpa server
 * (see `vite.config.ts`).
 */
const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    root.render(
        <StrictMode>
            <main className="screen screen--message">
                <h1>Echo loop demo</h1>
                <p>Access token required: open this page with the same fragment printed when Sherpa starts.</p>
                <p className="muted">http://localhost:5173/dev.html#t=&lt;token&gt;</p>
            </main>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });
    root.render(
        <StrictMode>
            <EchoApp store={store} token={token} />
        </StrictMode>,
    );
}
