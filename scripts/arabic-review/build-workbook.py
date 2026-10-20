"""
Builds the Arabic wording review workbook from the app's interface strings.

Usage:
  npx tsx scripts/arabic-review/export-strings.ts > strings.json
  python3 scripts/arabic-review/build-workbook.py strings.json ConversaFlow-Arabic-Review.xlsx

The reviewer fills in only the yellow columns. The developer applies "Change" rows back into apps/web/lib/i18n.ts
and marks them "Applied".
"""
import json
import re
import sys

from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

SHOTS = 'docs/reports/evidence/ui'

# Screen, where on screen, screenshot base name (None = no screenshot yet), sort order
SCREENS = [
    ('Sign-in', 'Sign-in page, brand panel and form; two-step code step', 'sign-in', ['signIn', 'brand.tagline', 'features', 'lang']),
    ('Sign-up', 'Create account page', None, ['signUp']),
    ('Forgot password', 'Password reset request page', None, ['forgot']),
    ('Verify email', 'Page opened from the verification email', None, ['verify']),
    ('Reset password', 'Page opened from the reset email', None, ['reset']),
    ('Page not found', 'Shown when an address does not exist', None, ['notFound']),
    ('All app screens', 'Side menu, top bar, shared buttons and messages; notice shown only in unsupported browsers', 'dashboard', ['nav', 'common', 'brand.by', 'browser']),
    ('Dashboard', 'Home page after sign-in', 'dashboard', ['dashboard']),
    ('Company settings', 'Business hours, languages, response targets, holidays', 'company-settings', ['company', 'days', 'languageNames']),
    ('Team and roles', 'Team list and role badges', 'team', ['team', 'roles']),
]

NOTES = {
    'brand.by': 'Kept in Latin script on purpose (brand lockup). Check only; no translation expected.',
    'lang.switchTo': 'Button that switches to the OTHER language, so in Arabic it correctly reads "English".',
    'roles.agent': 'Role name for front-line staff who reply to customers.',
    'dashboard.welcome': '{name} is replaced by the person\'s name.',
    'dashboard.trial': '{date} is replaced by a date such as 2 نوفمبر 2026.',
    'common.later': 'Short badge next to menu items not yet available. Must stay short (fits beside the menu text).',
}


def screen_for(key):
    for i, (name, where, shot, prefixes) in enumerate(SCREENS):
        for p in prefixes:
            if key == p or key.startswith(p + '.'):
                return i, name, where, shot
    raise SystemExit(f'No screen mapped for key {key}')


def main(src, out):
    rows = json.load(open(src, encoding='utf-8'))
    items = []
    for r in rows:
        i, name, where, shot = screen_for(r['key'])
        items.append((i, name, where, shot, r))
    items.sort(key=lambda x: (x[0], x[4]['key']))

    wb = Workbook()
    font = 'Arial'
    head = Font(name=font, bold=True, color='FFFFFF')
    head_fill = PatternFill('solid', fgColor='0E7490')
    src_fill = PatternFill('solid', fgColor='F1F5F9')
    input_fill = PatternFill('solid', fgColor='FFFF00')
    thin = Side(style='thin', color='CBD5E1')
    border = Border(left=thin, right=thin, top=thin, bottom=thin)
    wrap = Alignment(wrap_text=True, vertical='top')
    rtl = Alignment(wrap_text=True, vertical='top', horizontal='right', readingOrder=2)

    # ---------------- Instructions ----------------
    ins = wb.active
    ins.title = 'Instructions'
    ins.sheet_view.showGridLines = False
    lines = [
        ('ConversaFlow — Arabic wording review', Font(name=font, bold=True, size=16, color='0F172A')),
        ('Thank you for reviewing the Arabic text of the ConversaFlow web app. Each row on the "Review" sheet is one piece of text, grouped by screen.', None),
        ('', None),
        ('What to do', Font(name=font, bold=True, size=12)),
        ('1. Fill in your name and the date below.', None),
        ('2. On the Review sheet, read the English (column E) and the current Arabic (column F). Screenshots of most screens are listed in column C.', None),
        ('3. In column G choose OK, Change or Question.', None),
        ('4. If you choose Change, write the corrected Arabic in column H. Keep any word in curly brackets, for example {name}, exactly as it is.', None),
        ('5. Use column I for any comment or question (Arabic or English).', None),
        ('6. Only the yellow cells are yours to edit. Please do not change the grey columns.', None),
        ('7. The Summary sheet shows how many rows are left on each screen.', None),
        ('', None),
        ('Style guide', Font(name=font, bold=True, size=12)),
        ('• Modern Standard Arabic suitable for Gulf business users (Saudi Arabia and UAE).', None),
        ('• Short and clear: many labels must fit on a phone screen.', None),
        ('• Western digits (0–9), as used across the app.', None),
        ('• The product name ConversaFlow and "by Meronatic" stay in Latin letters.', None),
        ('• Address the user politely; avoid overly formal or literary phrasing.', None),
        ('', None),
        ('Example of a completed row (illustration only — not on the Review sheet)', Font(name=font, bold=True, size=12)),
    ]
    for i, (text, f) in enumerate(lines, start=1):
        c = ins.cell(row=i, column=1, value=text)
        c.font = f or Font(name=font, size=11)
        c.alignment = Alignment(wrap_text=True, vertical='top')
    ex_row = len(lines) + 1
    ex_head = ['Screen', 'English', 'Arabic now', 'Your verdict', 'Corrected Arabic', 'Comment']
    ex_vals = ['Sign-in', 'Forgot password?', 'نسيت كلمة المرور؟', 'Change', 'هل نسيت كلمة المرور؟', 'More natural as a question in Gulf usage']
    for j, (h, v) in enumerate(zip(ex_head, ex_vals), start=1):
        hc = ins.cell(row=ex_row, column=j, value=h)
        hc.font, hc.fill, hc.border = head, head_fill, border
        vc = ins.cell(row=ex_row + 1, column=j, value=v)
        vc.font, vc.border = Font(name=font), border
        vc.alignment = rtl if j in (3, 5) else wrap
        if j >= 4:
            vc.fill = input_fill
    meta = ex_row + 3
    for k, label in enumerate(['Reviewer name', 'Review date', 'Reviewer role / company']):
        ins.cell(row=meta + k, column=1, value=label).font = Font(name=font, bold=True)
        v = ins.cell(row=meta + k, column=2)
        v.fill, v.border, v.font = input_fill, border, Font(name=font)
    ins.cell(row=meta + 4, column=1, value='Legend: yellow = for the reviewer to fill in; grey = source text, do not edit.').font = Font(name=font, italic=True, color='475569')
    ins.column_dimensions['A'].width = 34
    for col in 'BCDEF':
        ins.column_dimensions[col].width = 26
    for i in range(2, len(lines) + 1):
        ins.merge_cells(start_row=i, start_column=1, end_row=i, end_column=6)

    # ---------------- Review ----------------
    ws = wb.create_sheet('Review')
    headers = ['#', 'Screen', 'Screenshots (Arabic)', 'Key', 'English (source)', 'Arabic now',
               'Your verdict', 'Corrected Arabic', 'Comment / question', 'Must keep', 'Check', 'Developer: applied']
    widths = [5, 18, 34, 22, 36, 36, 14, 36, 30, 12, 20, 14]
    for j, (h, w) in enumerate(zip(headers, widths), start=1):
        c = ws.cell(row=1, column=j, value=h)
        c.font, c.fill, c.border = head, head_fill, border
        c.alignment = Alignment(wrap_text=True, vertical='center')
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.cell(row=1, column=7).comment = Comment('Choose OK, Change or Question.', 'ConversaFlow')
    ws.cell(row=1, column=10).comment = Comment('Placeholder that must appear unchanged in any corrected text.', 'ConversaFlow')

    for n, (_, name, where, shot, r) in enumerate(items, start=1):
        row = n + 1
        token = ' '.join(re.findall(r'\{\w+\}', r['ar']))
        shots = (f'{SHOTS}/ar-mobile-{shot}.png\n{SHOTS}/ar-desktop-{shot}.png' if shot
                 else 'No screenshot yet — open the page in Arabic on staging')
        vals = [n, name, shots, r['key'], r['en'], r['ar'], None, None, NOTES.get(r['key']), token or None, None, None]
        for j, v in enumerate(vals, start=1):
            c = ws.cell(row=row, column=j, value=v)
            c.font = Font(name=font, size=10 if j in (3, 4) else 11, color='475569' if j in (3, 4) else '0F172A')
            c.border = border
            c.alignment = rtl if j in (6, 8) else wrap
            if j in (1, 2, 3, 4, 5, 6, 10):
                c.fill = src_fill
            if j in (7, 8, 9):
                c.fill = input_fill
        # Notes written by us sit in the comment column as guidance; keep them visibly distinct.
        if r['key'] in NOTES:
            ws.cell(row=row, column=9).font = Font(name=font, size=10, italic=True, color='475569')
        ws.cell(row=row, column=11, value=(
            f'=IF(G{row}="","To review",IF(AND(G{row}="Change",H{row}=""),"Add corrected text",'
            f'IF(AND(H{row}<>"",J{row}<>"",ISERROR(SEARCH(J{row},H{row}))),"Keep "&J{row},"")))'
        ))
        ws.cell(row=row, column=11).font = Font(name=font, size=10, color='B91C1C')
    last = len(items) + 1

    verdict = DataValidation(type='list', formula1='"OK,Change,Question"', allow_blank=True,
                             error='Choose OK, Change or Question.', errorTitle='Your verdict')
    applied = DataValidation(type='list', formula1='"Applied,Not needed"', allow_blank=True)
    ws.add_data_validation(verdict)
    ws.add_data_validation(applied)
    verdict.add(f'G2:G{last}')
    applied.add(f'L2:L{last}')
    ws.conditional_formatting.add(f'A2:L{last}', FormulaRule(formula=[f'$G2="Change"'], fill=PatternFill('solid', fgColor='FEF3C7')))
    ws.conditional_formatting.add(f'A2:L{last}', FormulaRule(formula=[f'$G2="Question"'], fill=PatternFill('solid', fgColor='DBEAFE')))
    ws.freeze_panes = 'E2'
    ws.auto_filter.ref = f'A1:L{last}'

    # ---------------- Summary ----------------
    sm = wb.create_sheet('Summary')
    sm_head = ['Screen', 'Rows', 'Reviewed', 'OK', 'Change', 'Question', 'Left to review', 'Changes applied']
    for j, h in enumerate(sm_head, start=1):
        c = sm.cell(row=1, column=j, value=h)
        c.font, c.fill, c.border = head, head_fill, border
        sm.column_dimensions[get_column_letter(j)].width = 18 if j > 1 else 22
    rng = lambda col: f'Review!${col}$2:${col}${last}'
    for i, (name, *_rest) in enumerate(SCREENS, start=2):
        sm.cell(row=i, column=1, value=name)
        sm.cell(row=i, column=2, value=f'=COUNTIFS({rng("B")},A{i})')
        sm.cell(row=i, column=3, value=f'=COUNTIFS({rng("B")},A{i},{rng("G")},"<>")')
        sm.cell(row=i, column=4, value=f'=COUNTIFS({rng("B")},A{i},{rng("G")},"OK")')
        sm.cell(row=i, column=5, value=f'=COUNTIFS({rng("B")},A{i},{rng("G")},"Change")')
        sm.cell(row=i, column=6, value=f'=COUNTIFS({rng("B")},A{i},{rng("G")},"Question")')
        sm.cell(row=i, column=7, value=f'=B{i}-C{i}')
        sm.cell(row=i, column=8, value=f'=COUNTIFS({rng("B")},A{i},{rng("L")},"Applied")')
    tot = len(SCREENS) + 2
    sm.cell(row=tot, column=1, value='Total')
    for j in range(2, 9):
        col = get_column_letter(j)
        sm.cell(row=tot, column=j, value=f'=SUM({col}2:{col}{tot - 1})')
    for row in sm.iter_rows(min_row=2, max_row=tot):
        for c in row:
            c.font = Font(name=font, bold=(c.row == tot))
            c.border = border

    wb.save(out)
    print(f'{out}: {len(items)} strings across {len(SCREENS)} screens')


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
