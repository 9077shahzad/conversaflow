# Staging environment — recommended configuration (revised 22 Oct 2026)

**For your decision. Nothing has been bought, created or deployed.** Purchase and deployment remain pending your
approval.

Prices are list prices in US dollars before VAT, read on 22 Oct 2026. Each price is marked:
- **official**: read on an AWS pricing or documentation page;
- **secondary**: from a named third-party price source;
- **to confirm**: an expected list price not yet read for Frankfurt.

AWS's regional pricing tables could not be read directly from this workspace, so Frankfurt-specific prices must be
confirmed in the AWS Pricing Calculator before any commitment. The totals are estimates, not quotes.

## The recommendation in one line

**AWS, Europe (Frankfurt) region `eu-central-1`, a lean single-zone copy of the planned production setup in its own
AWS account. About $146 a month if always on, or about $77 a month if run only during working hours. Budget target
$190 a month.**

**$190 is a budget target, not a limit.** No enforceable spending limit is available for this kind of account in
Frankfurt (see "Spending controls" below). AWS keeps charging until resources are stopped or deleted, and its billing
figures arrive hours late.

## What staging is for

A hosted copy of the product holding demo data only (no real customer data), used for:
- the hosted verification still pending (the app running on real servers rather than a build machine);
- **malware scanning with current official virus definitions**, which has not been verified so far;
- sign-up and two-step sign-in emails from a real email service;
- later, connecting a Meta test number to confirm the WhatsApp assumptions (message-ID matching, delivery statuses).

## Why Frankfurt, not a Gulf region

| Region | Status on 22 Oct 2026 | Source |
| --- | --- | --- |
| Saudi Arabia | Not open yet. Amazon says it is "on track to launch in December 2026" | aboutamazon.com, 31 Aug 2026 |
| Bahrain (`me-south-1`) | Disrupted. "The AWS Bahrain Region has been disrupted as a result of the ongoing conflict"; customers are asked to migrate to other regions | aboutamazon.com, 24 Mar 2026 |
| UAE (`me-central-1`) | Damaged. Trade press quoting AWS reports that data held only in one of its zones cannot be restored and that recovery of the others was continuing | datacenterdynamics.com, 16 Sep 2026 (secondary). The live AWS status page could not be read |
| Frankfurt (`eu-central-1`) | Long-established; all needed services, including email (SES) | AWS documentation |

Staging holds only invented data, so Saudi data-protection rules (PDPL) do not apply to it. Where production customer
data should live is a separate decision, best revisited when the Saudi region opens.

## Itemised monthly estimate

Assumptions:
- The month is 730 hours.
- There are four containers (API, web and worker on ARM; the virus scanner on x86), each with its own public address.
- The load balancer uses two public addresses.
- Under "working hours" (about 10 hours a day on weekdays, 220 hours a month), the containers and the database run
  220 hours. Everything else runs all month, because it cannot be paused.

| Item | Size | Hours | Unit price | Always on | Working hours | Price status |
| --- | --- | --- | --- | --- | --- | --- |
| App containers (API, web, worker) | ECS Fargate ARM, 1 vCPU and 2 GB in total | 730 / 220 | $0.0373 per vCPU-hour, $0.0041 per GB-hour | 33.16 | 9.99 | to confirm |
| Virus scanner (ClamAV, `clamav/clamav` image, x86 only) | Fargate x86, 0.5 vCPU and 4 GB | 730 / 220 | $0.0466 per vCPU-hour, $0.0051 per GB-hour | 31.92 | 9.62 | to confirm |
| Database | RDS PostgreSQL 16, `db.t4g.micro`, one zone | 730 / 220 | $0.019 per hour | 13.87 | 4.18 | secondary (sparecores.com) |
| Database storage | 20 GB gp3 (charged even when stopped) | month | about $0.137 per GB-month | 2.74 | 2.74 | to confirm |
| Database backups | 7 days kept; free up to the database size | month | — | 0.00 | 0.00 | official (free allowance) |
| Database CPU bursts | only if the database runs hot for long periods | — | $0.075 per vCPU-hour above baseline | 0 expected | 0 | official |
| Cache | ElastiCache Valkey, `cache.t4g.micro`, one node (cannot be stopped) | 730 | about $0.0144 per hour | 10.51 | 10.51 | to confirm |
| Load balancer | Application Load Balancer | 730 | $0.027 per hour | 19.71 | 19.71 | secondary (cloudburn.io) |
| Load balancer usage | demo traffic, under 1 capacity unit | 730 | about $0.008 per unit-hour | about 1.00 | about 0.50 | to confirm |
| Public addresses, load balancer | 2 | 730 | $0.005 per hour each | 7.30 | 7.30 | official |
| Public addresses, containers | 4 | 730 / 220 | $0.005 per hour each | 14.60 | 4.40 | official |
| File storage | S3, about 10 GB, private | month | about $0.0245 per GB plus requests | 0.35 | 0.35 | to confirm |
| Email | SES, about 1,000 emails | — | $0.10 per 1,000 | 0.10 | 0.10 | official |
| Secrets | Secrets Manager, 5 secrets | month | $0.40 per secret, $0.05 per 10,000 calls | 2.05 | 2.05 | official |
| Logs, intake | CloudWatch, about 5 GB (1.5 GB working hours) | — | about $0.63 per GB | 3.15 | 0.95 | to confirm |
| Logs, storage | kept 14 days | month | about $0.0324 per GB-month | 0.08 | 0.05 | to confirm |
| Container images | ECR, about 2 GB | month | $0.10 per GB-month | 0.20 | 0.20 | official |
| Domain records | Route 53 zone for `conversaflow.io` (domain already bought) | month | $0.50 per zone, $0.40 per million queries | 0.90 | 0.90 | official |
| HTTPS certificate | AWS Certificate Manager | — | free | 0 | 0 | official |
| Threat detection | GuardDuty, after its 30-day free trial | month | depends on activity | about 4 | about 3 | to confirm for Frankfurt |
| Internet data out | about 10 GB | — | first 100 GB a month free across the whole bill, then about $0.09 per GB | 0 | 0 | official (free allowance) |
| Traffic between zones | a few GB | — | $0.01 per GB each way | 0.10 | 0.05 | official |
| Budgets, alerts and the stop automation | 1–2 budgets with actions, small functions | — | first two budgets with actions free | 0 | 0 | official |
| **Total** | | | | **about $146** | **about $77** | |

**Options that change the total:**
- Running the scanner on ARM with the multi-architecture `clamav/clamav-debian` image saves about $6 a month (always
  on). This needs a check that the image behaves the same as the one used locally.
- A serverless Valkey cache instead of a node saves about $4 a month. The Frankfurt price has not been confirmed.
- With 3 GB instead of 4 GB for the scanner, the scanner must be set not to reload its definitions in parallel
  (`ConcurrentDatabaseReload no`). ClamAV's documentation gives 3 GiB as the minimum and 4 GiB as preferred. Saves
  about $4.
- The working-hours variant needs a small schedule (custom, see below) to start and stop the containers and the
  database each day. Outside those hours staging is unavailable, including for receiving WhatsApp test messages.

**Not included in the totals:**
- VAT and other taxes.
- An AWS support plan.
- A web firewall (WAF), a NAT gateway, a second zone or a standby database. Production would add these.
- Container Insights.
- Customer-managed encryption keys (about $1 per key a month).
- Extra alarms and log queries beyond the free allowance.
- Extra manual database or cache snapshots.
- Database CPU bursts if the database runs hot.
- More than 10 GB of internet data, or load testing.
- Domain renewal.
- Any AWS free-tier credits. They do not apply to an account inside an AWS Organization.
- Price changes after 22 Oct 2026.

## Spending controls

### Is there an enforceable spending limit? No, not for this account

AWS announced a monthly "spend limit" on 16 Sep 2026: "If spend reaches the limit, AWS pauses your project rather
than accumulating charges." It cannot be used for this staging account. The reasons, from AWS's account
documentation (read 22 Oct 2026):

- It exists only in the new simplified sign-up experience. It is in limited release ("You might not be able to access
  this experience yet"), works per project, and requires a paid plan.
- In that experience, AWS chooses the region from the contact address. Europe and the Middle East are placed in
  Stockholm (`eu-north-1`), not Frankfurt. "If you need to access a specific Region, use Sign up for AWS (advanced)."
- An account with advanced features (needed for Frankfurt, AWS Organizations and the full billing tools) cannot have a
  spend limit: "If you have a spend limit for any of your AWS accounts, it is removed … You cannot create a spend limit
  if you activate advanced features."
- GuardDuty is listed among the services not supported in the new experience.

Sources: aws.amazon.com/blogs/aws/aws-reimagines-the-getting-started-experience;
docs.aws.amazon.com/accounts/latest/reference/create-spend-limit.html; …/project-regions.html;
…/activate-advanced-features.html; …/supported-services-sign-up-new.html.

So **$190 is a budget target**. The controls below keep spending close to it, but they cannot guarantee it.

### Why the budget can be overshot

- **Billing delay.** "AWS Budgets information is updated up to three times a day. Updates typically occur 8–12 hours
  after the previous update." AWS also warns: "You might incur additional costs or usage that exceed your budget
  notification threshold before AWS Budgets can notify you". Cost Explorer data can be up to 24 hours old. Automatic
  actions can only react when the data refreshes. Allow for half a day to a day of charges after the target is
  crossed. At the always-on rate that is about $5, but a runaway cost could be larger.
- **Charges that continue after shutdown.** Stopping everything that can be stopped still leaves about **$45 a month
  (about $1.45 a day)**:

| Still charged when stopped | About $ a month |
| --- | --- |
| Load balancer (charged hourly until deleted) | 19.7 |
| Its two public addresses | 7.3 |
| Cache node (cannot be stopped; only snapshot and delete) | 10.5 |
| Database storage and backups ("you are charged for provisioned storage … You're also charged for backup storage") | 2.7 |
| Secrets, domain zone, images, files, stored logs | about 3.1 |
| Threat detection (lower when idle) | 1–2 |

  Containers scaled to zero cost nothing, and their public addresses are released.
- **The database restarts by itself after seven days.** "If you don't manually start your DB instance after it is
  stopped for seven consecutive days, RDS automatically starts your DB instance for you" (AWS RDS user guide). A
  stop made when the budget is reached therefore lasts at most seven days unless it is repeated. This is why the
  plan includes an automatic re-stop (below).

### Which controls are native AWS features and which need custom automation

| Control | Type | Notes |
| --- | --- | --- |
| Separate AWS account for staging, inside the company's AWS Organization | Native | The budget then covers exactly the staging bill |
| Budget alerts by email at 50% and 80% of actual spend and 100% of forecast | Native | Free |
| At 100% of actual spend: attach a "deny" policy so nobody can create or start resources | Native (budget action) | Set up in the staging account. A service control policy (SCP) version is also native, but must be set up in the Organization's management account |
| At 100%: stop the database | Native (budget action) | Must be set up in the staging account itself. Native actions can only stop EC2 and RDS instances |
| At 100%: scale the app and scanner containers to zero | **Custom** | Budget alert → notification topic → small Lambda function. No native action exists for containers |
| Re-stop the database when RDS restarts it after seven days | **Custom** | Rule on the RDS event "DB instance is being started due to it exceeding the maximum allowed time being stopped" (RDS-EVENT-0154) → Lambda that stops it again while staging is marked as paused |
| Daily start and stop for the working-hours variant | **Custom** | EventBridge Scheduler setting the container counts and starting or stopping the database |
| Stopping the cache, load balancer and public addresses | Not automated (recommended) | Removing them means rebuilding later. The plan accepts their cost (about $1.10 a day) instead |
| Cost Anomaly Detection | Native, optional | Emails if spending jumps unexpectedly |

The custom pieces would be written as configuration files, shown to you with the rest of the staging plan, and tested
in staging before they are relied on.

### Bringing staging back after an automatic stop

1. Check what caused the spending in Cost Explorer (the figures may be up to a day old). Decide whether to raise the
   budget or fix the cause.
2. Remove the "deny" policy (in Budgets, reverse the action) and clear the "paused" marker, so the database is not
   stopped again.
3. Start the database and wait until it is available (a few minutes).
4. Scale the containers back to their normal counts.
5. Check that the load balancer reports the app healthy, the database and cache connect, and the scanner has updated
   its definitions and detects the standard EICAR test file. Send a test email, and confirm that logs are arriving.
6. At the next budget refresh, confirm the spending rate is as expected.

## A cheaper alternative, not recommended

A single Lightsail server (8 GB memory, 2 vCPU) running everything together costs $44 a month (official price). It
would no longer test the production setup (managed database, containers, load balancer, secrets), and backups and
patching would become manual. It is not recommended for the hosted verification still pending.

## What happens after your approval

Nothing below starts without it.

1. You create (or approve creating) the staging AWS account under the company's AWS Organization. The budget,
   alerts and deny action are set up first, before any resource.
2. A configuration plan (Terraform) for staging, including the custom stop automation, is prepared and its priced
   plan shown to you. It creates nothing.
3. After you approve that plan, staging is created, demo data loaded and the hosted checks run. Results are reported
   separately from local and GitHub CI results.

**Still to confirm before committing:**
- every price marked "to confirm" or "secondary", in the AWS Pricing Calculator for `eu-central-1`;
- the live AWS status of the Gulf regions;
- that the scanner image chosen behaves as tested locally.
