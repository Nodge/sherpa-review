import { useEffect } from 'react';

/**
 * Open-chat class on the document root. CSS uses it to calculate `--dock-right` (the width
 * of chat docked on the right at ≥1280) and hide the floating action bar under the scrim
 * when chat is an overlay (<1280). `--dock-left`/`--dock-right` themselves are declared in
 * `components/review-action-bar.css` and are only available where the bar styles are loaded.
 */
export const CHAT_DOCK_CLASS = 'is-chat-docked';

/**
 * Chat docking breakpoint. Duplicates the media query in `components/review-action-bar.css`. CSS calculates layers and
 * widths, while JS uses the same condition to decide whether terminal actions are available.
 */
export const CHAT_DOCK_MEDIA = '(min-width: 1280px)';

/**
 * Chat overlays the content instead of docking as a right column. The action bar sits under its
 * scrim with its commands disabled. The question composer and Ship are not needed at the same time.
 * Read at the moment of the click, so no window-width listener is needed here.
 */
export function chatOverlaysContent(chatOpen: boolean): boolean {
    return chatOpen && !window.matchMedia(CHAT_DOCK_MEDIA).matches;
}

/**
 * Keeps the chat docking class on the document root while chat is open. CSS calculates widths
 * through a media query. There is deliberately no window-width listener.
 */
export function useChatDock(chatOpen: boolean): void {
    useEffect(() => {
        const root = document.documentElement;
        root.classList.toggle(CHAT_DOCK_CLASS, chatOpen);
        return () => {
            root.classList.remove(CHAT_DOCK_CLASS);
        };
    }, [chatOpen]);
}
