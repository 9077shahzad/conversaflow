# EU hosting comparison — AWS Frankfurt (primary) and Scaleway Paris (alternative)

**Provisional.** Both estimates are planning figures, not quotes. No account, purchase or deployment is approved;
hosting selection stays with the owner. Researched 19 Oct 2026 from list prices, excluding VAT; restructured
20 Oct 2026 without new pricing research. AWS figures are in US dollars, Scaleway in euros. The US-dollar equivalent
for Scaleway uses an **indicative** €1 = US$1.12 (EUR/USD close on 19 Oct 2026, 1.1227, Pound Sterling Live).

## Workload (identical for both)

| | Pilot (3–5 companies) | Growth (100 companies) |
| --- | --- | --- |
| Usage | ~50 agents, ~50,000 messages/month | ~2,000 agents, ~1 million messages/month |
| Environments | Production plus a smaller staging | Production plus staging |
| Application | API, worker, web, ClamAV — about 2 vCPU / 6 GB in production | About 9 vCPU / 22 GB across 2–4 API/worker instances, 2 ClamAV, web |
| PostgreSQL 16 | 20 GB, single instance (+ staging) | 200 GB with a standby copy (+ staging) |
| Files | 50 GB | 1 TB, copied to a second EU region |
| Email | ~5,000/month | ~200,000/month |
| Recovery target | Lose at most minutes of data; restore within hours | Lose at most minutes; restore within an hour |

## Comparable configurations

Our mapping of each cost line to each provider's equivalent service. Exact products and sizes are confirmed in
each provider's calculator (or a Terraform plan) before any commitment.

| Cost line | AWS Frankfurt (eu-central-1) | Scaleway Paris (fr-par, copies in nl-ams) |
| --- | --- | --- |
| Application containers | Managed containers (ECS on Fargate) | Managed containers (Serverless Containers or Kapsule) |
| Malware scanning | ClamAV container with `freshclam` | Same |
| Database | Managed PostgreSQL 16 (RDS), point-in-time restore; Multi-AZ standby at growth | Managed Database for PostgreSQL 16; HA at growth; **continuous backup added by us** (WAL archiving to object storage) |
| Cache | Managed Redis (ElastiCache) | Managed Redis |
| Files | S3, second-region copy at growth | Object Storage (S3-compatible), copy to Amsterdam |
| Backups and recovery copies | AWS Backup copies to a second region | Daily database backups in another region, plus our continuous backup |
| Network, load balancer, web firewall | Application Load Balancer, NAT gateway, AWS WAF | Load Balancer, Public Gateway; firewall rules (no managed WAF found) |
| Security services | GuardDuty, KMS, Secrets Manager | Key Manager and Secret Manager; **no threat-detection equivalent found** |
| Monitoring and logs | CloudWatch | Cockpit |
| Email | Amazon SES | Transactional Email (TEM) |
| Support plan | Developer (pilot), Business (growth) | Basic (free) or Advanced; Business at growth |

## Monthly totals (provisional)

| Cost line | AWS pilot (USD) | Scaleway pilot (EUR) | AWS growth (USD) | Scaleway growth (EUR) |
| --- | --- | --- | --- | --- |
| Application containers | 85 | 81 | 354 | 327 |
| Malware scanning (ClamAV) | 56 | 50 | 85 | 75 |
| Database (+ staging, automatic backups) | 49 | 49 | 406 | 227 |
| Cache (Redis) | 21 | 81 | 67 | 121 |
| Files and data transfer | 3 | 1 | 80 | 35 |
| Backups and recovery copies | 5 | 5 | 40 | 20 |
| Network, load balancer, web firewall | 143 | 22 | 224 | 71 |
| Security services | 33 | 2 | 90 | 2 |
| Monitoring and logs | 10 | 10 | 80 | 65 |
| Email | 0.50 | 1.20 | 20 | 50–100 |
| Support plan | 36 | 0–50 | 128 | 50–250 |
| **Total** | **≈ $442** | **≈ €302–352** | **≈ $1,574** | **≈ €1,043–1,293** |
| Indicative US$ (at €1 = $1.12) | $442 | ≈ $338–394 | $1,574 | ≈ $1,168–1,448 |

The Scaleway range comes from the support plan (and email at growth). The pricing model uses the AWS figures
excluding email ($441 pilot, $1,554 growth) because email is costed per company there.

## Assumptions

- List prices on 19 Oct 2026, on demand, no reserved or savings-plan discounts (these could lower AWS compute and database by roughly a third on a one- or three-year commitment).
- The split of compute between application containers and ClamAV is ours; ClamAV needs about 3 GB of memory per instance.
- Some AWS Frankfurt prices came from third-party price mirrors and must be checked in the AWS pricing calculator.
- Scaleway includes about €3 (pilot) and €10 (growth) for our own continuous database backup, which is needed to match AWS's point-in-time recovery. It takes one to two days to set up, plus a tested restore.
- Data transfer stays low because WhatsApp media is fetched on demand; heavy media use would raise it on both providers.

## Exclusions

- VAT; currency movements; reserved-capacity discounts.
- Domain, DNS and TLS certificates (small; often free).
- The independent security review, penetration-test environment time and any paid scanning service. ClamAV is open source.
- Meta (WhatsApp) fees, which customers pay directly, and AI usage (a later phase).
- Staff time to operate either platform. Scaleway needs more of it, because of the continuous backup and the lack of managed threat detection.
- A Gulf-region deployment (AWS has UAE and Bahrain regions; none found for Scaleway; not re-checked).

## What each option buys

| | AWS Frankfurt | Scaleway Paris |
| --- | --- | --- |
| Database recovery | Point-in-time restore built in; standby copy; copies to another region | Daily backups by default; point-in-time only with our own continuous backup (tested restore needed) |
| Threat detection | Managed (GuardDuty) | None found; our own monitoring |
| Certifications seen | ISO 27001, SOC 2, GDPR terms (standard; not re-checked) | ISO 27001:2022, HDS; SecNumCloud in progress; SOC 2 not mentioned |
| Moving later | Standard PostgreSQL, S3-style storage, containers and Terraform on both: a planned migration, not a rebuild | Same |

## Recommendation (for your decision; nothing is bought)

Use AWS Frankfurt as the primary option for the pilot: managed point-in-time recovery, threat detection and a
later path to Gulf regions, for about $50–100 a month more than Scaleway at pilot scale. Keep Scaleway as the
lower-cost alternative if continuous backup is added and its restore tested.

Next step once you approve: a Terraform **plan** for staging only. It lists the exact resources with a priced
estimate and creates nothing.

Still to check before any commitment:

- exact AWS Frankfurt prices in the AWS calculator;
- Scaleway DDoS protection and point-in-time restore;
- Saudi data-residency requirements (PDPL) and latency to the Gulf.
