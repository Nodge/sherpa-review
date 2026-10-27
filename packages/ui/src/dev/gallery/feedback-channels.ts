import type { UiFeedbackChannel } from '@sherpa/protocol';

/** Feedback channel with a form and a link to the discussion chat. */
export const GALLERY_FEEDBACK_ISSUES: UiFeedbackChannel = {
    kind: 'issues',
    available: true,
    reason: null,
    discussionUrl: 'https://chat.example.com/sherpa',
};

/** Link channel: the Feedback button opens the repository issues. */
export const GALLERY_FEEDBACK_LINK: UiFeedbackChannel = {
    kind: 'link',
    url: 'https://github.com/example/sherpa/issues',
};
