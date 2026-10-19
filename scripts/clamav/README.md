# Local ClamAV test signatures

Local and CI runs use the real ClamAV engine (clamd) loaded with ONLY this test signature, because the official
signature mirror is not reachable from the build environment. The signature matches the industry-standard
EICAR test string anywhere in a file.

Hosted environments must run ClamAV with official signatures kept current by `freshclam`
(e.g. the official `clamav/clamav` container image) — never this file alone.

## Official signatures are enforced

The API asks clamd for its signature state (`VERSION`) before every scan (cached for 60 seconds). Uploads are
refused (HTTP 503, nothing stored) when the official database is **missing**, **older than
`SCANNER_MAX_SIGNATURE_AGE_HOURS`** (default 48), or **unreadable**, as well as on scanner errors and timeouts.
Local and CI runs set `SCANNER_REQUIRE_OFFICIAL_SIGNATURES=false` because they load only the test signature;
production refuses to start with that setting. Hosted validation stays open until official signatures are installed,
updated by `freshclam`, and an upload is shown to pass and an EICAR file to be rejected in the target environment.
