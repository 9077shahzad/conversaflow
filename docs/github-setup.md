# Setting up the Meronatic-owned GitHub organisation and repository

Goal: Meronatic owns the code, the organisation and every credential. Developers (human or AI) are invited members
with the least access they need, and can be removed at any time without losing anything.

## 1. Create the organisation (about 10 minutes)

1. Sign in to GitHub with an account controlled by Meronatic (ideally a shared admin mailbox such as
   `it-admin@<meronatic-domain>`, not a personal address). Turn on two-factor authentication for it first.
2. Go to **github.com/organizations/plan** and create an organisation, for example `meronatic`.
   The **Free** plan is enough to start. (GitHub Team adds required reviewers and more CI minutes; that is a paid
   service and needs your separate approval.)
3. Under **Settings → Authentication security**, tick **Require two-factor authentication** for all members.
4. Add a second Meronatic owner (a trusted director) so access is never tied to one person.

## 2. Create the private repository

1. **New repository** → owner `meronatic`, name `conversaflow`, **Private**, no README (we push an existing history).
2. **Settings → General**: disable Wikis and Projects if unused; keep "Allow auto-merge" off.
3. **Settings → Branches → Add rule** for `main`:
   require a pull request before merging; require status checks to pass (`CI / checks`); block force pushes;
   do not allow deletions.
4. **Settings → Code security**: turn on Dependabot alerts, Dependabot security updates and secret scanning
   (secret scanning push protection is free for public repositories; on private repositories it may need GitHub
   Advanced Security, which is paid — leave it off unless approved; our CI runs gitleaks instead).

## 3. Give access

- Developers: invite as organisation **members** and give **Write** on the repository only. Never Admin.
- To let this Claude session push, tell me the organisation and repository name. I will request access through
  the GitHub connection; you approve it on GitHub. No password or token is ever shared in chat or stored in the code.

## 4. Keep credentials out of the codebase

- Real values live only in environment variables or, later, a secrets manager in the hosting account.
- `.env` files are git-ignored; `.env.example` holds placeholder names only.
- CI scans every commit with gitleaks and `pnpm secrets:scan`; a finding fails the build.
- CI uses throw-away database passwords for its temporary containers; it needs **no repository secrets** at all today.

## 5. First push (done by me once access is granted)

```bash
git remote add origin git@github.com:meronatic/conversaflow.git
git push -u origin main
```

Then open **Actions** to see the first CI run.
