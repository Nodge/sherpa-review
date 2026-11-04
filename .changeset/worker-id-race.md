---
'sherpa-review': patch
---

When two agent sessions start on the same pull request for the first time at once, they now always share one worker identity. Before, one session could occasionally pick up a route task that the other then failed to submit.
