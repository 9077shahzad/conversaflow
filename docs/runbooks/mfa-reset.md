# Runbook — resetting two-step sign-in for a user (M8)

**Status: not usable yet.** The process needs two different platform owners. Today there is one (Muhammad
Shahzad). Before this process can be used, a second platform owner must be named by the owner and added with
two-step sign-in. Until then, a user who loses both the authenticator and all recovery codes cannot be reset.

## When to use it

Only when a user has lost their authenticator **and** all ten recovery codes. A forgotten password is handled by the
normal reset email; it does not need this process.

## Steps

1. **Check identity** (platform owner A). Choose one method and note what you saw. Never write down document or
   account numbers. The system refuses six or more digits in a run (any script, even with spaces or dashes), so write
   dates in words ("20 Oct"), not as numbers.
   - `video_call_photo_id`: video call; compare the person with their photo ID and their profile.
   - `callback_known_number`: call back on a number already on file (not one given in the request).
   - `company_owner_confirmation`: the company's Owner confirms the person and the request, on a separate channel.
   - `in_person`: seen in person with photo ID.
2. **Request** (owner A, platform console): `POST /v1/platform/mfa-resets` with the user's email, the reason, the
   method and a short reference (for example "Video call 10:20 GST, matched photo and role").
3. **Approve** (owner B, a different platform owner, within 24 hours): open the list of pending requests
   (`GET /v1/platform/mfa-resets`), read the reason, the identity method and the reference, and confirm with owner A
   if anything is unclear. Then `POST /v1/platform/mfa-resets/<id>/approve`. Owner A cannot approve their own request. Nobody can reset their
   own account.
4. **What happens at once:**
   - the user's authenticators, recovery codes and pending confirmation codes are removed;
   - every session ends;
   - the user is emailed at their stored address;
   - both steps are written to the platform audit trail.
5. **The user** signs in with their password and sets up two-step sign-in again. The emailed confirmation code
   (M7) is required. Advise the user to change their password as well (forgot-password link), since the reason for
   the reset may include a lost device.
6. **To refuse instead:** `POST /v1/platform/mfa-resets/<id>/reject`.

## Never

- Reset on the strength of an email or chat message alone.
- Accept a callback number supplied in the request itself.
- Ask the user for their emailed confirmation code or recovery codes.
