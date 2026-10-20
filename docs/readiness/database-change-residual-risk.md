# Database changes — documented residual risk G4 (owner acceptance pending)

Recorded 20 Oct 2026, for candidate 3 (`rc3-tested` = `f1bc095`). No signature is requested until you have read
this note.

## What the risk is

Database changes (migrations) run with the database owner's rights. The automated isolation check (the CI guard)
catches accidental drift in who can write pilot enrolments and seat overrides, and it was strengthened in
candidate 3 (findings L-D, G2 and G3, all verified closed).

At `f1bc095` the independent reviewer showed one more case it cannot see: a migration could replace a table read by
one of the four reviewed billing and plan triggers (for example `trial_policy`) with a view that writes a seat
override. The reviewed function itself is unchanged, so the check passes.

No extension of the check can close this fully. A migration author with owner rights could write a seat override
directly, without any trick, so the real safeguard is people reviewing every database change before it is merged.

**Severity:** Low. It needs a deliberately harmful or careless migration to be merged, not an outside attacker.

## Safeguards and their status

| Safeguard | Status |
| --- | --- |
| Code-owner review of `packages/database/migrations/` and the guard's code by `security-owners` | **Pending** — prepared in `.github/CODEOWNERS`; enforced only after GitHub step 10 (`docs/github-setup.md`) is verified |
| `main` protected: pull request, 1 approval, code-owner review, `checks` green, no force push | **Pending** — GitHub steps 8–10 |
| CI guard (catches accidental privilege drift) | In place, local; first GitHub CI run pending |
| Only Meronatic-controlled people get Write; nobody gets Admin except the two owners | **Pending** — GitHub steps 3–5 |

Each line stays labelled pending until it is enforced and verified on GitHub, with evidence recorded.

## The acceptance (pending)

When you are ready, the proposed wording is:

> For the controlled pilot, I accept that a database change merged with owner rights could alter seat or pilot
> records in a way the automated isolation check does not detect. This acceptance is conditional on code-owner
> review of every database change being enforced and verified on GitHub before the pilot starts, and on only the
> two named Meronatic owners being code owners. It is reviewed before general availability.
>
> Name, date: ______________________

This is separate from the sign-in risk acceptance (`pilot-mfa-residual-risk.md`), which also remains pending.
