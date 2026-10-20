# Supported browsers (owner guide)

**Requirement:** ConversaFlow's web app needs a modern browser (ADR-031, Tailwind CSS 4).

| Browser | Minimum version | Typical devices |
| --- | --- | --- |
| Safari (iPhone, iPad, Mac) | **16.4** (iOS / iPadOS 16.4, March 2023) | iPhone 8 and later can run iOS 16 |
| Chrome (Android, Windows, Mac) | 119 (Oct 2023) | Any phone or computer with current updates |
| Edge | 119 | Windows computers with updates |
| Firefox | 128 (July 2024) | Any computer with current updates |
| Samsung Internet | 25 (Chromium 121) | Samsung phones with current updates |

Older browsers see a notice at the top of every page, in English and Arabic, asking the user to update. Pages may
also look unstyled. Supported browsers never show the notice (tested).

## How it is checked

| Check | Where | Status |
| --- | --- | --- |
| All browser checks in Chromium | Local and CI | Passing |
| The same checks in Firefox and WebKit (Safari's engine) | GitHub CI (`PW_ALL_BROWSERS=1`) | **Configured; first run pending GitHub set-up.** This build machine has Chromium only |
| Real devices: iPhone with iOS 16.4+, a Samsung or other Android phone with Chrome, a Windows PC with Edge, a Mac with Safari | Staging, before pilot access | **Pending** (needs staging) |

## Before pilot access

1. Ask each pilot company which phones and computers their team uses. Anything below the minimums needs an update
   before the pilot starts.
2. On staging, sign in, set up two-step sign-in, and open the dashboard, company settings and team pages on each
   real device above, in both languages.
3. Record the results (device, version, pass or fail) in the pilot readiness evidence.
