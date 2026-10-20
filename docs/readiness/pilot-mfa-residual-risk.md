# Pilot sign-in risk — what remains, and the acceptance still pending

Prepared 20 Oct 2026, revised for candidate 2.

- **Approved:** mandatory two-step sign-in for every pilot user.
- **Pending:** risk acceptance. This note explains the remaining risk before any signature is requested.

It relates to:
- ADR-027: the sign-in database credential;
- ADR-029: pilot enrolment;
- ADR-030: security notices;
- recheck item R2-1.

## 1. The one remaining account-takeover path

Two-step sign-in protects against a stolen or guessed **password**. What remains concerns the **sign-in database
credential**: the password the API uses to reach the database when it checks sign-ins.

**An attacker needs all three of these at once:**
1. the sign-in database credential;
2. a network route to the database;
3. a target account that has **not yet** set up two-step sign-in.

**The steps:**
1. Look up the target's account from their email address.
2. Open a session for that account directly in the database. This skips the password check, which runs in the API.
3. Start two-step set-up and register the attacker's own authenticator app.
4. Confirm it with a code from that app. The session is now fully verified, and the attacker can act as that user,
   with that user's role in the company.

**What the real user sees:**
- They are signed out of every other session at the moment the attacker confirms set-up.
- They receive the email "Two-step sign-in turned on", in English and Arabic, at their stored address.
- They cannot set up two-step sign-in themselves, because it is already on.

These signals are **detection, not prevention** (mitigation M5, kept as a detection measure).

**What the attacker cannot do with that credential:**
- take over an account that already has two-step sign-in (a session stops at the code step);
- read company data, files, two-step secrets or recovery codes;
- mark a session as verified without a correct code;
- act in the platform console;
- create password-reset or email-verification links.

All of this is tested, and the second independent recheck verified it at `6972acb`.

**Other effects of the same credential (no takeover):**
- **Lockout:** it could lock a user out of two-step sign-in for one hour by forcing 10 wrong codes.
- **Password guessing:** it could read password hashes and attempt slow offline guessing (Argon2id). For pilot users a
  cracked password alone opens nothing, because the second step is mandatory.
- **Sessions:** it could sign users out.

## 2. Protections during enrolment

| Step | Protection in place |
| --- | --- |
| Sign-up | Email must be verified through a link only the notification service can create (the sign-in credential cannot) |
| Invitation | Only people with permission to invite (Owners and Admins by default), and only once they have two-step sign-in, can invite. The link is single-use and expires after 7 days. It works only for the invited, verified email address |
| Entering a pilot company | Nothing in the company is reachable until two-step sign-in is set up and used in that session. File links issued earlier also stop working |
| Setting up two-step sign-in | Decided inside the database. Needs a real code. The secret is stored sealed. Set-up cannot be restarted over an existing one. All other sessions end. A notice is emailed |
| The window that matters | From account creation until the user's own set-up. With onboarding on a call (M4), this is minutes |

## 3. Protections during recovery

| Situation | What happens today |
| --- | --- |
| Forgotten password | A reset link goes to the stored address (single use, one hour). All sessions end. Two-step sign-in stays on, so the reset alone does not open the account |
| Phone lost, recovery codes kept | Each of the 10 recovery codes works once, even if two requests race. Using one emails a notice |
| Phone and all recovery codes lost | **Gap: there is no reset procedure yet.** Recovery would need a manual database operation, which is unsafe without a defined process. See M8 |
| Someone else enabled two-step sign-in on the account | The user gets the notice email and cannot sign in. Recovery needs the M8 procedure |

## 4. Mitigations

| # | Mitigation | Reduces | Status | Effort |
| --- | --- | --- | --- | --- |
| M1 | Sign-in credential held in the cloud secrets manager, readable only by the API service, rotated every 90 days and when staff change | All | Planned for staging | Included in hosting |
| M2 | Database on a private network only, TLS required | All (removes requirement 2 for outsiders) | Planned for staging | Included |
| M3 | Alert on any sign-in-role connection from outside the API service | All (detection) | To configure with hosting | About 1 hour |
| M4 | Pilot teams set up two-step sign-in on the onboarding call; platform staff confirm none is pending before data is loaded | Takeover window | Ready to adopt | Part of onboarding |
| M5 | Email notice on set-up and on recovery-code use, raised inside the database | Takeover (**detection**) | **Built and tested** | — |
| M7 | **A new authenticator activates only after the user clicks a link emailed to their stored address.** The sign-in credential cannot create or read that link | Takeover (**prevention** unless the attacker also controls the mailbox) | Not built | About 1–2 days plus review |
| M8 | Two-person, identity-checked, audited reset of two-step sign-in by platform owners, through the console | Recovery gap | Not built | About 1 day plus review |
| M9 | Pilot invitations expire after 72 hours instead of 7 days | Takeover window | Not built (one setting) | Under an hour |
| M6 | Move password checking into the database, so the credential alone never opens a session | Takeover, lockout, sign-out | Not built | About 3–5 days plus review |

**Recommendation:**
- Build M7, M8 and M9 before the first pilot invitation; about 3 days in total.
- Adopt M1–M4 with staging and onboarding.
- Schedule M6 before general availability.

With M7, takeover would need the database credential, network access **and** the user's mailbox. The acceptance
below would then cover a far narrower risk.

## 5. The acceptance (pending: not requested until you decide on M7–M9)

Proposed wording, to be confirmed once you have chosen the mitigations:

> For the controlled pilot only, I accept that a person holding the sign-in database credential and with network
> access to the database could take over a pilot account that has not yet completed two-step set-up [and, once M7
> is in place, who also controls that user's mailbox], could lock a user out of two-step sign-in for up to one hour,
> and could attempt offline guessing of password hashes. This acceptance is conditional on M1–M5 [and M7–M9] being
> in place before the first invitation. It ends at the close of the pilot or before general availability, whichever
> comes first, when M6 is reviewed.
>
> Name, date: ______________________
