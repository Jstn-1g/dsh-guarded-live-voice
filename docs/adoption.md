# Adoption measurement

DSH Live Voice measures completed external outcomes, not repository traffic.
Each public count must link to reviewable evidence and stay bound to the exact
release and environment that produced it.

| Signal | Count when | Do not infer |
| --- | --- | --- |
| External install reported | A non-maintainer report identifies an exact artifact and reaches installed or later | A clone, asset download, catalog view, or maintainer run |
| Successful voice turn | A non-maintainer report reaches `turn.done: completed`; synthetic and credential-backed paths remain separate | That audio used a physical device or live Qwen unless directly reported |
| External star | The repository's public non-owner stargazer count at a dated snapshot | The owner's star, an install, active user, or successful turn |
| Test report | A non-maintainer submits a complete sanitized report that maintainers can review | A comment, reaction, or incomplete private anecdote |
| Contributor | A non-maintainer-authored change is merged while preserving authorship | A fork, draft, or maintainer rewrite of someone else's idea |
| Setup abandonment | A tester records the last successful stage and stopping point | Failure of later stages that were never attempted |

The structured tester form records the conversion stages: install started,
install completed, profile restarted, **Open DSH Live Voice** control visible,
disclosure opened, synthetic turn started, response visible, transcript placed
into the draft, and full completion. Passing and failing reports are both
useful.

Do not publish credentials, recordings, real transcripts, Session identifiers,
workspace content, launch tokens, cookies, personal data, or identifying logs.
