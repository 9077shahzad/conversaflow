# EU hosting comparison — same workload, AWS Frankfurt (primary) and Scaleway (alternative)

Research only. **No account, purchase or deployment is approved.** Figures are monthly list-price estimates excluding
VAT, from the comparison researched on 19 Oct 2026, re-cut by cost line. AWS is in US dollars, Scaleway in euros (not
converted). Some AWS Frankfurt prices came from third-party price mirrors and must be checked in the AWS pricing
calculator before any commitment.

## Workload (identical for both)

| | Pilot (5 companies) | Growth (100 companies) |
| --- | --- | --- |
| Usage | ~50 agents, ~50,000 messages/month | ~2,000 agents, ~1 million messages/month |
| Containers | API, worker, web, ClamAV — production about 2 vCPU / 6 GB, plus a smaller staging | About 9 vCPU / 22 GB across 2–4 API/worker instances, 2 ClamAV, plus staging |
| PostgreSQL 16 | 20 GB, single instance + staging | 200 GB with a standby copy (high availability) + staging |
| Files | 50 GB | 1 TB, copied to a second EU region |
| Email | ~5,000/month | ~200,000/month |

## Pilot — monthly estimate

| Cost line | AWS Frankfurt (USD) | Scaleway Paris (EUR) | Notes |
| --- | --- | --- | --- |
| Application containers (API, worker, web) | 85 | 81 | Our split of the researched compute total |
| Malware scanning (ClamAV containers, prod + staging) | 56 | 50 | Our estimate: ClamAV needs ~3 GB memory per instance |
| Database (PostgreSQL + staging, automatic backups) | 49 | 49 | |
| Cache (Redis) | 21 | 81 | |
| File storage and data transfer | 3 | 1 | |
| Backups and recovery copies | 5 | 5 | Scaleway includes ~€3 for our own continuous database backup (see Recovery) |
| Network, load balancer, web firewall | 143 | 22 | AWS NAT gateway and load balancer dominate |
| Security services (threat detection, keys, secrets) | 33 | 2 | No Scaleway threat-detection equivalent found |
| Monitoring and logs | 10 | 10 | |
| Email (Amazon SES / Scaleway TEM) | 0.50 | 1.20 | |
| Support plan | 36 | 0–50 | Scaleway Basic is free; Advanced about €50 |
| **Total** | **≈ $442** | **≈ €302–352** | |

## Growth — monthly estimate

| Cost line | AWS Frankfurt (USD) | Scaleway Paris (EUR) | Notes |
| --- | --- | --- | --- |
| Application containers | 354 | 327 | |
| Malware scanning (3 ClamAV instances) | 85 | 75 | Our estimate |
| Database with standby copy, 14–30 day backups, staging | 406 | 227 | |
| Cache (Redis) | 67 | 121 | |
| Files 1 TB + second-region copy + data transfer | 80 | 35 | |
| Backups and recovery copies | 40 | 20 | Scaleway includes ~€10 for continuous database backup |
| Network, load balancer, web firewall | 224 | 71 | |
| Security services | 90 | 2 | |
| Monitoring and logs | 80 | 65 | |
| Email | 20 | 50–100 | |
| Support plan | 128 | 50–250 | Scaleway Advanced or Business |
| **Total** | **≈ $1,574** | **≈ €1,043–1,293** | |

## What the money buys — recovery, security and moving later

| | AWS Frankfurt | Scaleway Paris |
| --- | --- | --- |
| Database recovery | Point-in-time restore built in; standby copy; copies to another region. Data loss: minutes. Restore: under an hour | Daily backups (7 days by default) kept in another region; point-in-time restore not documented. Without our own continuous backup, up to 24 h of data could be lost. With it (one to two days to set up, plus a tested restore): minutes |
| Threat detection | GuardDuty (managed) | None found; would rely on our own monitoring |
| Malware scanning | ClamAV container with official signatures kept current by `freshclam` (same on both) | Same |
| Certifications seen | ISO 27001, SOC 2, GDPR terms (standard; not re-checked today) | ISO 27001:2022, HDS; SecNumCloud in progress; SOC 2 not mentioned; GDPR terms available |
| File storage compatibility | S3 | S3-compatible |
| Gulf regions later | UAE and Bahrain regions exist (general knowledge, not re-checked today) | None found |
| Moving between them | Standard PostgreSQL, S3-style storage, containers and Terraform on both: a planned migration, not a rebuild | Same |

## Recommendation

Cost the **AWS Frankfurt** scenario in detail as the primary option (managed point-in-time recovery, threat detection,
a later path to Gulf regions), with Scaleway as the lower-cost alternative if continuous database backup is added and
its restore is tested. The next step, once approved, is a Terraform **plan** for staging only, which shows the exact
resources and a priced estimate without creating anything.

Still unknown and worth checking before commitment: exact AWS Frankfurt prices in the AWS calculator; Scaleway DDoS
protection and point-in-time restore; Saudi data-residency (PDPL) and latency to the Gulf.
