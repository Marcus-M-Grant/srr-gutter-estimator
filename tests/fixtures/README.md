# Frozen test fixtures

`pricing.csv` and `rules.csv` here are a **snapshot of the pricing as it stood
when the acceptance tests were written**, at the original 45% target margin.
They are deliberately frozen and must not be refreshed from the live sheet.

Why: the arithmetic tests exist to prove the *engine* is right - that
`ceil(200 x 1.10)` is 220, that a Half Round gutter picks the round downspout
code, that a subtotal of 4,412.03 rounds to 4,425. None of that is a statement
about what SRR charges this week.

Pointing those tests at `/data` meant every price change in the Google Sheet
broke ten of them, which trains everyone to update expected numbers without
reading them - exactly the habit that lets a real pricing bug through.

Tests that genuinely are about the live data - that the shipped snapshot loads
without errors, carries no placeholder rows, and has a positive price on every
row - still read `/data` directly. Those SHOULD react when the sheet changes.
