import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readFragmentParam } from '../../fragment.js';
import { IconSprite } from '../../icons/icon.tsx';
import '../../styles/base.css';
import { Gallery, parseGalleryLocale } from './gallery.tsx';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

createRoot(container).render(
    <StrictMode>
        <IconSprite />
        <Gallery
            initialTheme={readFragmentParam(window.location.hash, 'theme') === 'light' ? 'light' : 'dark'}
            initialId={readFragmentParam(window.location.hash, 'state')}
            initialLocale={parseGalleryLocale(readFragmentParam(window.location.hash, 'locale'))}
        />
    </StrictMode>,
);
