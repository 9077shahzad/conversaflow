# Pilot sign-in risk — what remains after M7–M9, and the acceptance still pending

Revised for candidate 3, 20 Oct 2026.

- **Approved and built:** mandatory two-step sign-in for every pilot user.
- **Built in candidate 3:** M7, M8 and M9.
- **Pending:** risk acceptance. No signature is requested until you have read this note.

## 1. What changed

| Before candidate 3 | Now |
| --- | --- |
| A holder of the sign-in database credential could register their own authenticator on an account that had not yet set one up, and get a fully verified session | They can start set-up, but finishing needs an 8-digit code emailed to the account's **verified address**. The code is created only by the notification service, read from the stored address inside the database, valid for 15 minutes, single-use, and works only in the session that started set-up. The sign-in credential cannot read, create or redirect it, or change the address (all tested) |
| No safe way to recover a user who lost the authenticator and all recovery codes | Two-person, identity-checked, audited reset that ends every session and tells the user (M8). **Usable only once a second platform owner exists** |
| Pilot invitations valid for 7 days, no way to cancel one | Pilot invitations valid for 72 hours, single use, revocable at once (M9) |

## 2. The account-takeover path that remains

An attacker now needs **all four** of these at once:
1. the sign-in database credential;
2. a network route to the database;
3. an account that has not yet finished two-step set-up;
4. **the user's mailbox**, or the user's cooperation in reading the emailed code aloud.

**What the real user sees:**
- the confirmation email ("Your code to finish setting up two-step sign-in", which says never to share it);
- if the attacker succeeds: being signed out everywhere, the "Two-step sign-in turned on" notice, and being unable
  to set up two-step sign-in themselves.

The notices remain **detection** measures.

**Accounts that already have two-step sign-in cannot be taken over this way.** With onboarding on a call (M4), the
window before set-up is minutes. Invitations now lapse after 72 hours.

## 3. Other exposure from the same credential (no takeover)

| # | Effect | Severity | Mitigation |
| --- | --- | --- | --- |
| R1 | Lock a user out of two-step sign-in for one hour, by forcing 10 wrong codes | Low | M1–M3 protect the credential; M6 removes it |
| R2 | Read password hashes (Argon2id) and attempt slow offline guessing. A cracked password alone opens no pilot account | Low | M1–M3; strong password rules already enforced |
| R3 | Sign users out, or keep a session's idle timer fresh (never past the 12-hour limit) | Low | M1–M3; M6 |
| R4 | Start set-up on someone's account, which sends them an unexpected confirmation email | Nuisance | The email tells them to ignore it and reset their password |

## 4. The reset process itself (M8)

The reset is a powerful action, so it needs two different platform owners and an identity check recorded without
document numbers. It is fully audited, ends every session and emails the user.

The remaining risk is two owners colluding or both being deceived; the runbook's "never" rules reduce the second.
**Until a second platform owner is named, the reset cannot be used at all**, and a user who loses everything stays
locked out.

## 5. Mitigations, now and next

| # | Mitigation | Status |
| --- | --- | --- |
| M1 | Sign-in credential in the cloud secrets manager, readable only by the API service, rotated every 90 days and when staff change | Planned for staging (needs hosting decision) |
| M2 | Database on a private network only, TLS required | Planned for staging |
| M3 | Alert on any sign-in-role connection from outside the API service | To configure with hosting |
| M4 | Pilot teams set up two-step sign-in on the onboarding call; platform staff confirm none is pending before data is loaded | Ready to adopt |
| M5 | Email notices on set-up, recovery-code use and reset | **Built** (detection) |
| M7 | Emailed confirmation code, bound to the session, before an authenticator activates | **Built** (candidate 3) |
| M8 | Two-person, audited reset of two-step sign-in | **Built**; needs a second platform owner to be usable |
| M9 | Pilot invitations: single use, revocable, 72 hours | **Built** (candidate 3) |
| M6 | Move password checking into the database, so the credential alone never opens a session | Not built; about 3–5 days plus review; recommended before general availability |

## 6. The acceptance (pending)

When you are ready, the proposed wording is:

> For the controlled pilot only, I accept that a person who holds the sign-in database credential, has network
> access to the database **and** controls a pilot user's mailbox (or obtains the emailed code from the user) could
> take over that user's account before the user finishes two-step set-up. I also accept that the same credential
> could lock a user out of two-step sign-in for up to one hour and allow offline guessing of password hashes. This
> acceptance is conditional on M1–M5 and M7–M9 being in place before the first invitation, and on a second platform
> owner being named before the reset process (M8) is relied on. It ends at the close of the pilot or before general
> availability, whichever comes first, when M6 is reviewed.
>
> Name, date: ______________________
