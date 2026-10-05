/* Base layer goes first: control state rules must come in the cascade
   before component styles, which add their layout on top. */
import '../../styles/base.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { readFragmentParam } from '../../fragment.js';
import { IconSprite } from '../../icons/icon.tsx';
import { Gallery, parseGalleryLocale, parseGalleryTextSize, parseGalleryTheme } from './gallery.tsx';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element #root not found');
}

createRoot(container).render(
    <StrictMode>
        <IconSprite />
        <Gallery
            initialTheme={parseGalleryTheme(readFragmentParam(window.location.hash, 'theme'))}
            
            initialTextSize={parseGalleryTextSize(readFragmentParam(window.location.hash, 'textsize'))}
            initialId={readFragmentParam(window.location.hash, 'state')}
            initialLocale={parseGalleryLocale(readFragmentParam(window.location.hash, 'locale'))}
        />
    </StrictMode>,
);
