# Local ClamAV test signatures

Local and CI runs use the real ClamAV engine (clamd) loaded with ONLY this test signature, because the official
signature mirror is not reachable from the build environment. The signature matches the industry-standard
EICAR test string anywhere in a file.

Hosted environments must run ClamAV with official signatures kept current by `freshclam`
(e.g. the official `clamav/clamav` container image) — never this file alone.
