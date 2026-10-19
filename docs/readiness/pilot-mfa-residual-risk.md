# Pilot two-step sign-in — remaining exposure and the acceptance still needed

Prepared 20 Oct 2026. Relates to ADR-027 (sign-in credential), recheck item R2-1 and ADR-029 (pilot enrolment).

## What the new rule does

Every member of a pilot company must set up two-step sign-in and use it in the session before any company data,
setting or file is reached. This is enforced on the server for every company request and every download, and is
tested (`apps/api/test/pilot.test.ts`).

## What it does not do

The rule protects against a stolen or guessed **password**. It does not change what someone could do with the
**sign-in database credential** (`cf_identity`), which the API uses to check passwords. If that credential leaked,
the holder could still:

| # | What they could do | Who is exposed | Effect of the pilot rule |
| --- | --- | --- | --- |
| E1 | Open a session for a user who has **not yet** set up two-step sign-in, then register their own authenticator for that user and obtain a fully verified session | Pilot users between account creation and their own setup (invitations last 7 days) | Narrows the window to that gap; does not close it |
| E2 | Open a session for a user who **has** set up two-step sign-in | All users | Session stops at the code step: no data |
| E3 | Lock a user out of two-step sign-in for one hour by forcing 10 wrong codes (R2-1) | All users | None |
| E4 | Read password hashes (Argon2id) and attempt slow offline guessing | All users | A cracked password alone no longer opens a pilot account |
| E5 | Sign users out, or keep a session's idle timer fresh (never beyond the 12-hour limit) | All users | None |
| E6 | Create new user accounts (as sign-up does) | — | They belong to no company and see nothing |

It cannot read company data, files, two-step secrets, recovery codes or the sealing key, cannot mark a session as
verified, and cannot act in the platform console (all tested; second independent recheck of `6972acb`).

## Mitigations available

| Mitigation | Reduces | Status | Cost |
| --- | --- | --- | --- |
| M1 Keep the sign-in credential in the cloud secrets manager, readable only by the API service, rotated every 90 days and when staff change | All | Planned for staging (deployment runbook) | Included in hosting estimate |
| M2 Database reachable only from the application network, TLS required, no public address | All | Planned for staging | Included |
| M3 Connection logging with an alert on any sign-in-role connection from outside the API service | All (detection) | To configure with hosting | About 1 hour of setup |
| M4 Onboard each pilot team on a call: everyone sets up two-step sign-in in the first session; platform staff confirm none are pending before data is loaded | E1 | Ready to adopt in the pilot onboarding steps | Part of onboarding time |
| M5 Email the account's stored address when two-step sign-in is turned on or a recovery code is used, raised inside the database so it cannot be skipped | E1 (detection) | **Built** (migration 0012) and tested, including a replay of E1 | None |
| M6 Move password checking into the database, so the sign-in credential alone can never open a session | E1, E2, E3, E5 | Not built — about 3–5 days plus review | Development and review time |

Recommendation: adopt M1–M4 for the pilot (M5 is already in place), and schedule M6 before general availability.
A new-device sign-in notice is a further option (about 1 day).

## Acceptance still required

Mandatory two-step sign-in is now configured. What still needs your written decision is this:

> I accept, for the controlled pilot only, that a person holding the sign-in database credential could (E1)
> take over a pilot account that has not yet set up two-step sign-in, (E3) lock a user out of two-step sign-in for
> up to one hour, and (E4) attempt offline guessing of password hashes, on the condition that mitigations M1–M4 are
> in place before the first invitation and M5 stays enabled. This acceptance ends at the
> close of the pilot or before general availability, whichever is first, when M6 is reviewed.
>
> Name, date: ______________________

Alternatively, require M6 before the pilot (adds about one week plus independent review).
