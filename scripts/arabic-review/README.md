# Arabic wording review

A native Arabic business reader checks every interface string, screen by screen, in one Excel workbook. No coding
is needed on their side.

## Produce the workbook

```bash
pnpm exec tsx scripts/arabic-review/export-strings.ts apps/web/lib/i18n.ts > /tmp/strings.json
python3 scripts/arabic-review/build-workbook.py /tmp/strings.json docs/readiness/ConversaFlow-Arabic-Review.xlsx
```

Re-run both lines whenever the wording changes, so the reviewer always sees the current text.

## What the reviewer does

1. Read the **Instructions** sheet (one filled example row shows the format).
2. On **Review**, for each row choose **OK**, **Change** or **Question** in "Your verdict".
3. For **Change**, write the corrected Arabic. Placeholders such as `{name}` listed under "Must keep" stay exactly as
   they are; the Check column turns red if one is missing.
4. Add a comment where the meaning or tone needs explaining.
5. Fill in name and date, save, and return the file. **Summary** shows the totals.

## Applying corrections

A developer copies each accepted correction into `apps/web/lib/i18n.ts`, marks "Developer: applied", runs the web
tests and browser checks, and screenshots the changed screens in Arabic for the reviewer's final look.
