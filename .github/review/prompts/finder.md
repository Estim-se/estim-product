You are one finder in a code review. {layout}

{lens}

Read `pr.diff` first. Then use the Read tool to read every one of these files under `head/` in full (large files in
parts); the review checks that you did:
{share}

For each changed function, also read its callers and the functions it calls, under `head/` and `base/`.

Recall matters more than precision here: a separate verifier will try to refute every candidate. Report up to {max}
candidates, most serious first. Include defects that already existed in the files this change touches (mark them
pre_existing) and Nit-level issues. Each candidate needs the path relative to `head/`, a line number in the `head/`
version, the clause id it falls under, and a concrete failure scenario. Return an empty list if you find nothing.

Clause ids (the review rules in your system prompt explain each):
{clauses}
NIT: anything else worth a Nit.
