# Release archives — SHA-256 checksums

Archives are kept outside the repository (they contain it). Verify with `sha256sum <file>` (Linux),
`shasum -a 256 <file>` (macOS) or `Get-FileHash <file> -Algorithm SHA256` (Windows PowerShell).

| Candidate | File | Contents | SHA-256 |
| --- | --- | --- | --- |
| 3 | `conversaflow-c3b6d3d.zip` | Source tree at `rc3-packaged` (`c3b6d3d`) | `4f3aa8325f8381cf37f07c81c4ff8d05b336d82b911ef16aa0107fd39c222953` |
| 3 | `conversaflow-c3b6d3d.bundle` | Full git history and tags up to `rc3-packaged`; `git bundle verify` reports it okay | `fee0f286165681b236c214cc00737326187892b4439e73510957f83ab1fda770` |
| 2 | `conversaflow-bec9ee8.zip` | Source tree at `rc2-packaged` (`bec9ee8`) | `cb87bfa82e77d428bedc48ae76cbcd8b22c19a68d7cd4baf9269263184759ecc` |
| 2 | `conversaflow-bec9ee8.bundle` | Full git history and tags up to `rc2-packaged` | `dc71688eeb119dd9cd2d7444ec215d4e7b0227670edc202a63c72421f1ec6070` |
| 1 | `conversaflow-92e9c2e.zip` | Source tree at `rc1-packaged` (`92e9c2e`) | `560955e2e48468bb7cc3d996e95b3b9d2f10c79c7a498bb26a38fc617a66acd1` |
| 1 | `conversaflow-92e9c2e.bundle` | Full git history and tags up to `rc1-packaged` | `c8faa26006b1b2d75460246e73b389a5637787a67c7447a9a13e08f6013d09b5` |

The bundle holds `refs/heads/main` = `c3b6d3d`, `rc3-tested` → commit `f1bc095`, `rc3-packaged` → commit `c3b6d3d`
(the tag objects themselves have their own hashes, `7885e32` and `9a1d256`).
