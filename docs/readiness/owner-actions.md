# Actions needed from you — one consolidated list

Kept up to date as development continues. Everything below has been prepared as far as it can be from here.
Nothing has been bought, pushed, connected, submitted or deployed. Development that does not depend on these actions
carries on without them.

Order: the first three unlock the most. Costs are list prices before tax, as read on the dates given in the linked
documents.

| # | Action | Exact step | My recommendation | Cost | What it unlocks |
| --- | --- | --- | --- | --- | --- |
| 1 | **Company GitHub repository, then the push** | Create the organisation `meronatic-group` on GitHub (Free plan) while signed in as 9077shahzad; then connect GitHub to Claude for that organisation (claude.ai → Settings → Connectors → GitHub) and reply "approve push to meronatic-group/conversaflow". Steps one screen at a time: `docs/github-setup.md` §3 | Do it now (about 20 minutes) | $0 for the import and first CI run | The push of the tested branch; the first CI run (needs your separate "approve first CI run", with the Actions budget set to $0); code-owner enforcement later |
| 2 | **GitHub Team, before branch protection** | Approve the upgrade at step 8 of `docs/github-setup.md` | Approve after the first CI run is green | $4 per user per month for 12 months, 2 seats = about $96 the first year | Protected `main`, required review and checks (closes the safeguards behind G4) |
| 3 | **Staging hosting** | Approve the AWS staging proposal: create the staging AWS account under the company and allow the budget and alerts to be set up first, then review the priced Terraform plan before anything is created | AWS Frankfurt, always on during verification | About $146 a month (or about $77 working hours only); budget target $190, not an enforceable limit (`docs/readiness/staging-recommendation.md`) | Hosted verification: malware scanning with current definitions, real email, session expiry, storage permissions, backup restore, real-device checks; later the Meta test number |
| 4 | **Meta: contracting entity and business verification** | Confirm MERONATIC SOLUTIONS GROUP, LLC (Delaware) as the contracting party; then approve submitting the verification documents (Certificate of Formation, EIN letter, a bank statement or utility bill in the exact legal name) | Confirm and submit; it is the longest chain before a pilot | No Meta fee | Tech Provider set-up and App Review, connecting real WhatsApp numbers (W1.10), live template review, live message costs (W1.11), WhatsApp Flows |
| 5 | **AI provider account** | Choose the provider and create an API account in the company's name; add the key to the staging secrets store yourself when staging exists (never in chat or code) | Anthropic API, with a monthly spending limit set in its console | Usage-based; set a cap you are comfortable with (for example $50 a month during the pilot) | Live AI replies, translation and summaries. Until then these run on a clearly labelled simulated AI so everything else can be built and tested |
| 6 | **Risk decisions** | Read and either sign or reject: `docs/readiness/database-change-residual-risk.md` (G4) and `docs/readiness/pilot-mfa-residual-risk.md` (sign-in risk) | Sign G4 after GitHub protection is verified; sign the sign-in risk once staging mitigations are scheduled | None | Pilot access (both must be closed or accepted by you) |
| 7 | **External security review** | Approve sending the prepared request to Cure53, Doyensec and Cyphere (`docs/readiness/security-review-rfq.md`) | Approve contact now; the review itself is a later approval | Contact free; review about €8,000–22,000 | Independent penetration test before pilot access |
| 8 | **Legal documents** | Instruct counsel: terms of service, privacy notice, data processing agreement, acceptable use policy, pilot agreement; include AI providers and transfers outside Saudi Arabia (PDPL) | Instruct now | Counsel fees | Pilot contracts |
| 9 | **People** | Name a second platform owner (two-person sign-in reset), a native Gulf-Arabic business reviewer (about 2 hours), and the pilot companies | Name them when convenient | Reviewer time | Sign-in resets; Arabic sign-off; pilot invitations |
| 10 | **Domain** | After hosting is approved, point `conversaflow.io` to staging (DNS records will be given to you exactly) | After item 3 | Included in the domain you bought | Real web address for staging and email |
| 11 | **Telling customers a reply is automated** | Confirm whether AI answers sent to customers must always say they are automated, or whether each company may turn the note off | Keep it on by default and let companies turn it off only after legal advice (item 8); this is how it is built now | None | A settled rule for AI disclosure in the terms and in the product |

Later, only when those waves are reached: Salla and Zid partner accounts (commerce apps), payment merchant accounts
(Moyasar, Tap or HyperPay), Apple and Google developer accounts (native apps), and Gulf-dialect reviewers. Each will be
added here with its exact step when the work that needs it is ready.
