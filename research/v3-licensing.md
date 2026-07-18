# Uniswap V3 Licensing — Can you launch a public, commercial V3 clone?

_Research ticket resolution. Date of investigation: 2026-07-16. All license identifiers verified against the raw LICENSE files in the source repos._

## TL;DR verdict

**Yes — in mid-2026 a public, commercial Uniswap V3 fork is licensing-clear, because the BUSL-1.1 Change Date has already passed.**

- Uniswap `v3-core` was released under **BUSL-1.1** with a **Change Date of 2023-04-01** and a **Change License of GPL-2.0-or-later**. That date is **~3 years in the past**, so by the BUSL's own automatic-conversion terms, v3-core is **now GPL-2.0-or-later** — even though the LICENSE file on `main` still displays the BUSL text (the conversion is by operation of the license, not by a file edit).
- Uniswap `v3-periphery`'s root LICENSE file is now **plain GPL-2.0** (GitHub reports `gpl-2.0`).
- Because it's GPL now, **no Additional Use Grant / governance vote is needed** anymore, and the old chain restrictions are moot.
- **The only remaining constraint is GPL-2.0 copyleft** (publish your modified contract source under GPL-2.0-or-later) plus the fact that the **"Uniswap" trademark/branding is not licensed**.

---

## 1. BUSL-1.1 on v3-core: what it forbade, the Change Date, and whether it has passed

Verified verbatim from `https://raw.githubusercontent.com/Uniswap/v3-core/main/LICENSE`:

```
Licensor:             Uniswap Labs
Licensed Work:        Uniswap V3 Core (c) 2021 Uniswap Labs
Additional Use Grant: Any uses listed and defined at
                      v3-core-license-grants.uniswap.eth
Change Date:          The earlier of 2023-04-01 or a date specified at
                      v3-core-license-date.uniswap.eth
Change License:       GNU General Public License v2.0 or later
```

**What BUSL-1.1 permits/forbids (during the BUSL period):**
- Permitted freely: copy, modify, create derivative works, redistribute, and **non-production** use.
- **Forbidden without a commercial license or an Additional Use Grant: production use** — i.e. running the code in a live/commercial deployment. A competing commercial deployment was exactly the use the BUSL was designed to block during the restricted window.
- On violation, rights terminate automatically; you must buy a commercial license from Uniswap Labs or stop using it.

**Change Date — and has it passed? YES.**
- The Change Date is the **earlier of `2023-04-01`** or an ENS-specified date. The wording "the earlier of" means governance could only ever *accelerate* the date; the hard cap is **2023-04-01**.
- Independently, the license also converts on the **"fourth anniversary of the first publicly available distribution"** of each version. V3 shipped in 2021, so that anniversary (~2025) has also passed.
- **Today is 2026-07-16 — both triggers are well in the past.** Therefore v3-core is now governed by its **Change License = GPL-2.0-or-later**, and "the rights granted in the paragraph above [the BUSL production-use restriction] terminate."

**Caveat on the file text:** the `main` LICENSE file was never rewritten, so it still *reads* as BUSL. This is cosmetic — conversion happens "effective on the Change Date" by the terms of the document itself, not upon a commit. GitHub's license classifier still reports `NOASSERTION` / "Other" for v3-core because it parses the BUSL file text.

## 2. The "Additional Use Grant" and chain restrictions

- The Additional Use Grant pointed to the ENS record **`v3-core-license-grants.uniswap.eth`**, controlled by Uniswap Governance (via `uniswap.eth`).
- During the BUSL period it was the **only** mechanism to get permission for a production use — most notably **deploying V3 to a new chain**. Teams wanting V3 on another chain (or to use BUSL-protected code in their own project) had to pass a **Uniswap DAO governance proposal** to receive a grant. Several cross-chain deployments (e.g. the deploy-v3 tooling, L2 forks) went through this.
- So yes, the grant regime effectively gated **specific-chain deployments** behind governance approval.
- **As of mid-2026 this is moot** — with the Change Date passed, GPL-2.0-or-later applies to everyone for all chains; no grant is required.

## 3. Jeiwan `uniswapv3-book` and `uniswapv3-code` — a clean-room alternative?

Verified from the raw repos:

- **`Jeiwan/uniswapv3-code`** (the "build Uniswap V3 from scratch" code) does **NOT** carry MIT. Its `LICENSE` on `main` is a **verbatim copy of Uniswap's BUSL-1.1**, including `Licensor: Uniswap Labs`, `Licensed Work: Uniswap V3 Core`, `Change Date: 2023-04-01`, `Change License: GPL-2.0-or-later`. (GitHub reports `NOASSERTION` / "Other".)
  - **Implication:** it is *not* a license-clean escape hatch during the BUSL era — it inherited the exact same BUSL terms. But like v3-core, its Change Date has passed, so it too is **now GPL-2.0-or-later**.
- **`Jeiwan/uniswapv3-book`** (the prose/tutorial) has **no LICENSE file at all** (HTTP 404 on `LICENSE`; API `license` field is `null`; no license mention in the README). Absent an explicit grant, the book *text* is effectively **all rights reserved** by the author. This affects reusing the writing, not deploying code.

**Bottom line on Jeiwan:** it's a genuinely independent reimplementation (useful to avoid copying Uniswap's exact bytecode), but from a pure *license-identifier* standpoint it offers no advantage over the real thing today — both are GPL-2.0-or-later in 2026. Its value is educational / a from-scratch codebase, not a softer license.

## 4. Practical bottom line — deploying a V3 fork on a new EVM chain in mid-2026

1. **You do not need an Additional Use Grant and you do not need to ask Uniswap Governance.** The BUSL production-use restriction expired at the Change Date (2023-04-01). v3-core and v3-periphery are GPL-2.0-or-later.
2. **You must comply with GPL-2.0-or-later copyleft**: if you distribute/deploy modified contracts, you must make the corresponding **source available under GPL-2.0-or-later**. (For on-chain contracts this is generally low-friction; verify/publish source.) You cannot relicense the derivative contracts as proprietary/closed.
3. **Trademark is separate from copyright.** The GPL grants no rights to the **"Uniswap" name, unicorn logo, or branding** — a commercial clone must use its own brand. Front-end code, the interface, and the `Uniswap` marks are not covered by the contract license.
4. **Use a released version.** The conversion "applies separately for each version"; every V3 version was published in 2021–2022, so all are past both the 2023-04-01 cap and their 4-year anniversary. Any V3 release you fork today is GPL.
5. **Non-contract components differ.** This analysis covers `v3-core` and `v3-periphery` smart contracts. The Uniswap Labs front-end/interface repos and other tooling carry their own (sometimes more restrictive) licenses — check each separately if you reuse them.

---

## Confidence / gaps

- **High confidence:** v3-core LICENSE parameters (BUSL-1.1, Change Date 2023-04-01, Change License GPL-2.0-or-later) — read verbatim via `raw.githubusercontent.com`. The Change Date having passed is unambiguous given the "earlier of" wording caps it at 2023-04-01 and today is 2026-07-16.
- **High confidence:** v3-periphery root LICENSE is GPL-2.0 (raw file + GitHub API `gpl-2.0`).
- **High confidence:** Jeiwan `uniswapv3-code` carries a copied BUSL-1.1; `uniswapv3-book` has no license file.
- **Minor gap:** Individual `.sol` files in both Uniswap repos carry per-file SPDX headers (a mix of `GPL-2.0-or-later` and, historically, `BUSL-1.1`). Post-Change-Date this is immaterial (all resolve to GPL), but if forking a *specific* file pre-2023 provenance mattered, check its SPDX header. Not a blocker in 2026.
- **Minor gap:** GPL-2.0 compliance specifics (how "distribution" maps to on-chain deployment, source-publication mechanics) are a legal-interpretation question, not a license-identifier question — flagged, not resolved here. For a real launch, get a lawyer to sign off on GPL-2.0 obligations.
- **Not covered:** licenses of Uniswap front-end/interface, SDK, and permit2/other peripheral repos.

## Sources

- Uniswap v3-core LICENSE (raw, BUSL-1.1): https://raw.githubusercontent.com/Uniswap/v3-core/main/LICENSE
- Uniswap v3-core LICENSE (GitHub view): https://github.com/Uniswap/v3-core/blob/main/LICENSE
- Uniswap v3-periphery LICENSE (raw, GPL-2.0): https://raw.githubusercontent.com/Uniswap/v3-periphery/main/LICENSE
- GitHub license API — v3-core: https://api.github.com/repos/Uniswap/v3-core/license (reports NOASSERTION/"Other")
- GitHub license API — v3-periphery: https://api.github.com/repos/Uniswap/v3-periphery/license (reports gpl-2.0)
- Official: "Uniswap v3 licensing" — Uniswap Labs support: https://support.uniswap.org/hc/en-us/articles/14569783029645-Uniswap-v3-licensing
- Uniswap Foundation — "FAQ on Uniswap v3's Business Source License": https://paragraph.com/@uniswap-foundation/faq-on-uniswap-v3-s-business-source-license
- Uniswap deploy-v3 (cross-chain deployment tooling + Additional Use Grant context): https://github.com/Uniswap/deploy-v3
- Jeiwan/uniswapv3-code LICENSE (raw, copied BUSL-1.1): https://raw.githubusercontent.com/Jeiwan/uniswapv3-code/main/LICENSE
- Jeiwan/uniswapv3-book (no LICENSE file; repo root): https://github.com/Jeiwan/uniswapv3-book
- BUSL-1.1 canonical text (MariaDB): https://mariadb.com/bsl11/
