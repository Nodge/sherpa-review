import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readFragmentParam } from '../../fragment.js';
import '../../styles/base.css';
import { Gallery } from './gallery.tsx';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

createRoot(container).render(
    <StrictMode>
        <Gallery initialId={readFragmentParam(window.location.hash, 'state')} />
    </StrictMode>,
);
