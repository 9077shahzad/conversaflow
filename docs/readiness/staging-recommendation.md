# Staging environment — recommended configuration (22 Oct 2026)

**For your decision. Nothing has been bought, created or deployed.** Purchase and deployment remain pending your
approval. Prices are list prices before VAT, read on 22 Oct 2026. Some regional prices could only be read from
secondary sources and are marked; all of them must be confirmed in the AWS Pricing Calculator before any commitment.

## The recommendation in one line

**AWS, Europe (Frankfurt) region `eu-central-1`, a lean single-zone copy of the planned production setup, about
$145 a month, with a spending cap of $190 a month in its own AWS account.**

## What staging is for

A hosted copy of the product holding demo data only (no real customer data), used for:
- the hosted verification still pending (the app running on real servers rather than a build machine);
- **malware scanning with current official virus definitions**, which has never been verified so far;
- sign-up and two-step sign-in emails from a real email service;
- later, connecting a Meta test number to confirm the WhatsApp assumptions (message-ID matching, delivery statuses).

## Why Frankfurt, not a Gulf region

| Region | Status on 22 Oct 2026 | Source |
| --- | --- | --- |
| Saudi Arabia | Not open yet. Amazon says it is "on track to launch in December 2026" | aboutamazon.com, 31 Aug 2026 |
| Bahrain (`me-south-1`) | Disrupted. "The AWS Bahrain Region has been disrupted as a result of the ongoing conflict"; customers are asked to migrate to other regions | aboutamazon.com, 24 Mar 2026 |
| UAE (`me-central-1`) | Damaged. Trade press quoting AWS reports that data held only in one of its zones cannot be restored and that recovery of the others was continuing | datacenterdynamics.com, 16 Sep 2026 (secondary). The live AWS status page could not be read |
| Frankfurt (`eu-central-1`) | Long-established; all needed services, including email (SES) with SMTP | AWS documentation |

Staging holds only invented data, so Saudi data-protection rules (PDPL) do not apply to it. Frankfurt also matches the
pilot-production plan of 19 Oct 2026, so staging tests the same setup. **Where production customer data should live
is a separate decision**, best revisited when the Saudi region opens. Staging will be built from configuration files
so that moving regions later is straightforward.

## What is included

| Part | Configuration | $/month |
| --- | --- | --- |
| Application (API, worker, web) | Managed containers (ECS Fargate, ARM), 1 vCPU and 2 GB in total, always on | 33 |
| Malware scanner | ClamAV container (x86), 0.5 vCPU and 3 GB, updating its virus definitions with `freshclam` | 28 |
| Database | Managed PostgreSQL 16 (RDS `db.t4g.micro`), one zone, 20 GB, 7-day automatic backups | 17 |
| Cache | Managed Valkey/Redis (`cache.t4g.micro`) | 11 |
| Load balancer and HTTPS | Application Load Balancer with a free AWS certificate | 23 |
| Public IP addresses | 6 (AWS charges for each) | 22 |
| File storage | S3, about 10 GB, private | 0.40 |
| Email | Amazon SES, about 1,000 emails | 0.10 |
| Secrets | Secrets Manager, 5 secrets (no passwords in code or files) | 2 |
| Logs and monitoring | CloudWatch, short retention | 0–3 |
| Threat detection | GuardDuty (30-day free trial first) | about 5 |
| Domain records | Route 53 hosted zone for `conversaflow.io` (domain already bought) | 0.50 |
| Container images, small extras | ECR and similar | about 0.50 |
| **Total** | | **about $145** |

Left out of staging on purpose: a second zone or standby database, a NAT gateway (saves about $42; containers use
public addresses with no inbound access except through the load balancer, while the database and cache stay private),
the web firewall (WAF) and a paid support plan. Production would add these, as in the 19 Oct comparison.

Price sources (read 22 Oct 2026): official AWS pages for public IPs, SES, Secrets Manager, Route 53, certificates and
GuardDuty; Frankfurt figures for Fargate, RDS, the load balancer and S3 from secondary price mirrors; RDS storage,
cache, CloudWatch and ECR rates in Frankfurt **not verified**. Possible extras: RDS burst charges if the database runs
hot for long periods; ClamAV may need 4 GB rather than 3 GB (about $4 more).

## Spending cap: $190 a month, and how it works

AWS has **no hard spending cap** on a standard account. Billing data also arrives with a delay of up to a day, so any
cap can be overshot slightly. The cap is therefore set up in layers:

1. **A separate AWS account just for staging**, so the budget covers its whole bill.
2. **A monthly budget of $190**, with email alerts at 50% and 80% of actual spend and at 100% of forecast spend.
3. **An automatic action at 100%**: block anyone from creating or starting resources, and stop the database.
4. **A small automatic step that scales the application containers to zero** at the same point (AWS's own budget
   actions cannot stop containers).
5. A few items keep charging until removed by hand (load balancer about $0.65 a day, the cache, storage). Treat $190
   as the point where everything is stopped and you are told, not as a guaranteed maximum.

Budget alerts are free; the first two budgets with actions are free.

AWS also announced a new "spend limit" for new accounts on 16 Sep 2026, rolling out gradually. It may not be offered
to this account, and whether it stops containers and load balancers is not verified. If it is offered, it can be
added as an extra safety net.

## A cheaper alternative, not recommended

A single Lightsail server (8 GB memory, 2 vCPU) running everything together costs $44 a month (official price). It
would save about $100 a month, but staging would no longer test the production setup (managed database, containers,
load balancer, secrets), and backups and patching would become manual work. It is not recommended for the hosted
verification still pending.

## What happens after your approval

Nothing below starts without it.

1. You create (or approve creating) the staging AWS account under the company, with the budget and alerts above set
   up first.
2. A configuration plan (Terraform) for staging is prepared and its priced plan shown to you. It creates nothing.
3. After you approve that plan, staging is created, demo data loaded and the hosted checks run. Results are reported
   separately from local results.

Still to confirm before committing: every price marked secondary or not verified, in the AWS Pricing Calculator for
`eu-central-1`; that ClamAV's official image runs on the chosen container type; the live AWS status of the Gulf
regions; whether the new spend limit is available to the account.
