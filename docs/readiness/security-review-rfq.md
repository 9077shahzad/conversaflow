# Request for quotation — independent security review (DRAFT, not sent)

Status: draft for owner approval (updated 20 Oct 2026). No supplier has been contacted. Send only after approval, under NDA, from a
Meronatic address.

---

**Subject:** Request for quotation — secure code review and penetration test, ConversaFlow (multi-tenant SaaS)

Dear [Supplier],

MERONATIC SOLUTIONS GROUP, LLC is preparing a controlled pilot of ConversaFlow, a multi-company customer
conversation platform (WhatsApp-first). Before any live customer access, we want an independent code-assisted
security review and penetration test. We would welcome your quotation for the scope below.

## 1. System in scope

| Item | Detail |
| --- | --- |
| Architecture | TypeScript monorepo: NestJS API (one codebase run as API and worker), Next.js web app (English and Arabic, right-to-left) |
| Data | PostgreSQL 16 with forced row-level security on every company table; four restricted database roles (business data, sign-in, notifier, platform console) |
| Identity | Email and password (Argon2id); TOTP two-step verification decided inside the database, with recovery codes and security notices; server sessions with idle and absolute expiry; two-step sign-in mandatory for pilot companies |
| Files | Uploads scanned by ClamAV (fail-closed, signature-freshness check); short-lived signed download links bound to user and company |
| Platform console | Owner staff access to customer data only through two-person, time-limited, audited support grants bound to the staff member's session; pilot enrolment by the platform owner only |
| Web security | Content Security Policy with a fresh nonce per page; no inline script or style |
| Size | About [N] thousand lines of TypeScript and SQL at feature freeze (currently about 9,200, plus about 2,800 lines of tests) |
| Environment | Production-like staging in an EU region (provider to be confirmed); synthetic data only |
| Not in scope now | WhatsApp/Meta integration, payments, AI features (later phases) |

## 2. Work requested

1. **Secure code review** (estimated 4–6 days): tenant isolation (row-level security policies, how each request sets the company), database role separation and SECURITY DEFINER functions, authorisation on every API route, sign-in/MFA/session handling and the documented residual risk of the sign-in database credential, signed file links, upload and scanning path, Content Security Policy, secrets handling, dependencies.
2. **Penetration test, grey-box, aligned to OWASP ASVS Level 2** (estimated 6–8 days): at least two companies × three roles cross-company matrix; API authorisation; MFA and session attacks; file upload and link abuse; injection; business logic (seats, trials, support access, billing state).
3. **Retest** of fixed findings within 30–90 days (estimated 1 day).

We will provide: source code access (read-only), architecture and threat-model documents, test accounts per role, the
existing automated security tests and the reports of two internal reviews.

## 3. Deliverables

- Rules of engagement and test plan before starting.
- Report with findings rated by severity (CVSS), proof of concept, affected code, and recommended fixes; a mapping to ASVS Level 2.
- Explicit evidence of the cross-company tests performed.
- Findings in CSV or JSON; a debrief call.
- Retest report, and a signed attestation letter we may share with pilot customers.

## 4. Please include in your quotation

1. Fixed price (or day rate and days) for each of items 1–3, currency and taxes.
2. Named testers and their qualifications (e.g. OSWE, BSCP, CREST CCT-App); confirmation that no subcontractors will be used without our written consent.
3. Company accreditations (e.g. CREST) and professional indemnity insurance.
4. A sample (redacted) report.
5. Earliest start date and duration; time to deliver the report after testing.
6. Experience with NestJS/Node.js and PostgreSQL row-level security.
7. Data handling: where our code and findings are stored, retention and deletion; willingness to sign our NDA and data processing agreement.

## 5. Timing

Code review at feature freeze for the pilot scope; penetration test 3–4 weeks before pilot access, so fixes and
the retest fit before go-live. Indicative window: [to be set once the Meta approval date is known].

Please reply to [Meronatic contact email] by [date]. We are happy to answer questions on a short call.

Kind regards,
[Name], MERONATIC SOLUTIONS GROUP, LLC

---

## Shortlist (for owner approval before any contact)

| Supplier | Base | Why on the list | Check before sending |
| --- | --- | --- | --- |
| **Cure53** | Berlin, Germany (EU) | Offers white-box tests and source code audits of web apps alongside black-box pentests; publishes reports with client permission (public reports 2020–2026 on its site) | No accreditation stated on its site; ask for named testers and a sample report |
| **Doyensec** | San Marino (EMEA office) and San Francisco | Application-security specialist (founded 2017); source code review and penetration testing named as core strengths; web apps and APIs listed | Confirm EU data handling for code and findings |
| **Cyphere** | Manchester area, United Kingdom | States it is CREST accredited; web application and API penetration testing; SME-oriented | Code review is not listed explicitly — ask; confirm CREST status in CREST's public directory |

Contact routes listed on their sites: Cure53 hello@cure53.de; Doyensec info@doyensec.com; Cyphere via its website.
Sources (opened 19 Oct 2026): cure53.de · doyensec.com/company.html · thecyphere.com/blog/crest-approved-provider/
