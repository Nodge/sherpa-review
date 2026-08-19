import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './app.css';
import { createStore } from './store.js';
import { readToken } from './token.js';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

const token = readToken(window.location.hash);
const root = createRoot(container);

if (token === null) {
    // Make no requests without a token. The skill/server launch prints a URL containing it.
    root.render(
        <StrictMode>
            <main className="screen screen--message">
                <h1>Sherpa</h1>
                <p>Open the UI using the link printed by the Sherpa skill or server. It contains the access token.</p>
                <p className="muted">The link looks like this: http://127.0.0.1:&lt;port&gt;/#token=&lt;token&gt;</p>
            </main>
        </StrictMode>,
    );
} else {
    const store = createStore({ token });
    root.render(
        <StrictMode>
            <App store={store} token={token} />
        </StrictMode>,
    );
}
