# Analysis 2 — Community landscape around the three-plane thesis

**Date:** 2026-10-16
**Scope:** External research supporting, contradicting, or instrumenting the
drupal-dev-planes design (knowledge / state / verification) and the
`OpenCode Agentic Engineering Harness.md` plan. Complements
`analysis-1-conclusions.md`.

## Headline

The three-plane thesis is no longer just ours. In 2026 the community
independently arrived at the same separation under the name **harness
engineering**: *guides* (what the agent should know before acting — our
knowledge + state planes) and *sensors* (what actually happened after acting —
our verification plane), with deterministic sensor output preferred over the
model's judgment of its own work. The verification literature supplies the
scientific ground for "never trust the commit": intrinsic self-correction
fails; only external, attributed feedback channels correct reliably.

The sharpest open question is not whether the planes work (analysis-1: they
do, as guardrails) but **when they are worth their token price** — the Jain
experiment shows the harness cost/benefit flips hard between frontier and
cost-optimized models. Our P3 (token-price table) is exactly the missing
instrument, and the sweep-harness plan already contains its outer-loop
counterpart.

## 1. The harness-experiment evidence

### Naresh Jain, "Are Harnesses Worth the Cost?" (martinfowler.com, 2026-10-13)

Paired 10-run experiment, Codex, one greenfield API service (178 external
acceptance tests, graded by an independent outer loop the inner harness never
saw):

| Model | Unharnessed | Harnessed | Harness cost |
|---|---|---|---|
| GPT-6 Sol (frontier) | 10/10 | 10/10 | 10.5× tokens, 7× cost |
| GPT-6 Luna (cost-tier) | **3/10** | **10/10** | ~3.9× tokens, but still **33% cheaper per run than unharnessed Sol** ($0.273 vs $0.406) |

Readings that matter for us:

- The harness "did not unlock a capability Luna lacked; it turned a 3-in-10
  baseline into 10-for-10 reliability" — Jain's own interpretation: the
  harness acts as **external memory and an attention aid**, pulling dropped
  requirements back into focus when a sensor goes red.
- The harness's sensors were **contract tests + mock assertions generated from
  human-supplied specs, not from the agent's own interpretation** — the same
  design rule as our verification plane's independent read-back.
- Unharnessed failure mode on Luna: requirements "losing influence during
  implementation" — i.e. silent partial success, our catalog's dominant
  failure class.
- Boundary condition, honestly stated: the brief was unusually complete, and
  the task fails **loudly** (API contract tests). Frontier models didn't need
  the harness there. Our claim is that Drupal adds a failure class — config
  imports cleanly, page 500s — that acceptance-test-style outer loops don't
  catch unless someone probes the delivered page. `verify_page` is the sensor
  for the silent class; nobody else in this literature is measuring it.

### Rahul Garg, "The Orchestrator's Tax" (martinfowler.com, July 2026)

The real value of a subagent is **what it keeps out of the orchestrator's
context**, not parallelism; names **cognitive locality** (work sharing a
mental model stays in one agent). Directly validates two things:

- Harness doc principle 5 and the rule "if a brief needs a page, the lead does
  it itself."
- Analysis-1 finding that the planes worked by *changing what could be
  trusted*, not by being the source of intelligence — verdict-first, small
  outputs are a context-protection mechanism.

### OpenAI, "Harness engineering: leveraging Codex in an agent-first world" (2026-02-11)

5-month experiment, ~1M LOC production beta, zero human-written lines; humans
design the environment (specs, tests, review gates, observability). Coined
"harness engineering." Confirms the direction our harness doc took: invest in
the loop around the model, not in prompts.

### Birgitta Böckeler, "Harness Engineering" (martinfowler.com)

Source of the **guides vs sensors** vocabulary and the **computational vs
inferential control** distinction. Maps cleanly:

| Our planes | Böckeler/Jain vocabulary |
|---|---|
| knowledge + state planes | guides |
| verification plane | sensors (computational) |
| SKILL.md routing rules | guide text |
| failure-mode catalog | the sensors' known blind spots, made explicit |

### Survey literature

- "From Question Answering to Task Completion: A Survey on Agent System and
  Harness Design" (arXiv 2606.20683) — harness-vs-no-harness scores across
  models; harness tiers raise weak models far more than strong ones
  (GPT-4o: 13.1 → 54.6 at "harness high").
- "Agent Harness for LLM Agents: A Survey" (110+ papers,
  github.com/Gloriaameng/Awesome-Agent-Harness) — the field now has a named
  taxonomy; our three-plane design is an instance of it. Worth mining for
  sweep-instrument ideas (R2E-Gym's procedural environments + hybrid
  verifiers parallels our fixture + detection-recipe pattern).
- "The Harness Gap: AI coding output rose 59% in 2025 while teams shipped 7%
  less" — the measurement-culture argument for sweep gates over vibes.

## 2. The verification literature (the science behind "never trust the commit")

- **Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet"
  (ICLR 2024, 1,500+ citations):** intrinsic self-correction (no external
  feedback) doesn't reliably catch errors and can *degrade* the answer. The
  bottleneck is self-assessment, not revision. Recommendation: build reliable
  **external** verification systems. That is the verification plane's charter.
- **2026 replication (via Splunk/MLM write-ups):** keep the error text
  byte-identical, change only its **attributed source** — own reasoning vs a
  tool, user, or memory entry — and correction rates move **23–93 percentage
  points**. Attribution to a non-self channel is most of the effect. This is
  the strongest single argument that verify tools must return
  mechanically-derived verdicts (`plane`, `provenance`, byte counts), not
  model-flavored judgments.
- **Confidence self-scores are near-random for predicting agent failure:**
  log-prob, self-consistency, and verbalized confidence all score
  AUROC ≈ 0.55–0.6 (2026 ACL work). An agent's "I'm confident" is not a
  verification instrument; `verify_page`'s HTTP status is.
- **"The Self-Correction Illusion: LLMs Correct Others but Not Themselves"
  (arXiv 2606.05976):** generator/verifier must be split — supports the
  harness doc's test-writer/coder separation and "the agent that writes code
  never judges it."
- **Kalai et al. (OpenAI, arXiv 2509.04664), "Why Language Models
  Hallucinate":** benchmarks reward guessing over abstention. Two
  agent-relevant hallucination types are named in practitioner write-ups
  (Firecrawl): **stale-data** and **confabulation** — both reduced by
  retrieval, neither eliminated. Exactly the knowledge plane's two enemies
  ("Drupal 7-shaped hooks", invented module names).
- **AA-Omniscience (Artificial Analysis, arXiv 2511.13029):** hallucination is
  now directly measured at the model level — but nobody measures it at the
  *domain level against a versioned corpus*. Our Family-B corpus sweep
  (retrieval rank + answerability per model) is a niche instrument with no
  published equivalent.

## 3. The Drupal community is converging on the same niches

- **Marcus Johansson, "Teaching Coding Agents What's Already on Drupal.org"
  (Drupal AI Learners Club, 2026-10-08, youtube.com/watch?v=TlFcD3LW8dA):** a
  DDEV add-on running a local MCP server with agent-consumable docs for
  ~**10,300 contrib modules** — hybrid BM25 + semantic search, compact
  per-module docs, "so your agent stops inventing modules that don't exist,"
  with evals behind it, handed to the Drupal AI initiative. Two notes:
  - This lands exactly on analysis-1 P2's recommended niche: knowledge that is
    **outside the repo and absent from training data** (contrib landscape,
    module selection). The community validated the niche before our corpus
    sweep did.
  - It is BM25/semantic doc retrieval, not a versioned, cited, closed-world
    index with claim-support checks. drupal-dev-mcp's differentiation survives;
    a knowledge-plane federation (their contrib corpus + our core corpus) is a
    realistic composition.
- **Dries Buytaert's 2026 series** — community-level conclusions from the
  project lead himself:
  - "Friction, abstraction and verification": agents reward **fast, verifiable
    progress**; "agents work best when they can inspect the system, reason
    about its state, and make changes with clear feedback" — that sentence is
    the state + verification planes in Drupal-first vocabulary.
  - "I gave an AI agent edit access to my website" (browser-use/Playwright
    agents): defines **explorer vs native agents**; native (API-integrated)
    agents suit single-site work. Supports a drush-backed state plane over
    browser automation as the sanctioned surface.
  - "Do AI coding agents recommend Drupal?" (recurring annual field test):
    agents reward **legibility before capability**; the asks are installable
    in one session, clear docs, strict APIs — an AX roadmap the planes
    directly serve.
  - "AI rewards strict APIs": agents struggle with ambiguity, not complexity.
- **DrupalCon Chicago 2026 / AI initiative:** Drupal CMS ships 22 AI agents
  out of the box, 48+ providers; Tag1 reported migrating a 100k-node D7→D11
  site largely with agents. The AI Agents framework + MCP module is the
  in-Drupal counterpart to our external MCP server; sweep-harness non-goal
  #2 (no third-party MCP sweeps yet) will eventually collide with it —
  worth a pairing recipe before they harden their own conventions.
- **Drupal AI Learners Club** (drupal.org/project/ai_learners) has session
  recaps becoming a standing community record — a channel to publish our
  token-price table and failure-mode catalog once swept.

## 4. What this changes in our plan

| Finding | Consequence |
|---|---|
| Jain: harness ROI flips by model tier; harness ≈ 33% cheaper than frontier at equal reliability | P3 token-price table should be run **per model tier**, not one average. The most persuasive row is "cost-tier model + verification plane vs frontier model raw." |
| Jain: sensors must derive from human expectations, not the implementing agent | Failure-mode detection recipes should be written/derived from the catalog row (human-curated), never regenerated by the sweeping agent. The sweep plan already implies this; make it a stated principle (#6). |
| Jain's outer loop (178 independent acceptance tests) | Sweep harness Family A needs the same separation: the sweep's *detect* step must not share code with the *reproduce* step. Currently `verify_page` plays both roles — acceptable (it's deterministic), but the record should label which side each assertion is on. |
| Self-correction/attribution research | Strengthen the response envelope: verdict + provenance + byte counts are load-bearing, not decoration. Consider recording them as the catalog row's *evidence* fields (the sweep gate could require them). |
| Johansson's contrib-module corpus | Knowledge-plane re-scope: core behavior (our index) + their contrib docs compose naturally. Contact the AI initiative before duplicating indexing effort on contrib. |
| Dries: legibility/AX as ranking factor for agents | `verify_page`'s suspicious-page heuristics and honest `status` enums are AX surface; polish them as if agents were the UX. |
| Böckeler guides/sensors vocabulary | Adopt in architecture.md — it makes the three planes legible to the wider harness-engineering audience in one line: "two guides, one sensor." |

## 5. Contradictions and open questions

1. **Is the verification plane worth its tokens on frontier models?** Jain's
   Sol data says no for loud-failure tasks. Our honest position: Drupal
   silent-failure classes are unproven territory for frontier agents; we have
   n=1 session (analysis-1) where they caught three false-success waves. The
   sweep harness is what turns that into a measured claim — including, ideally,
   a paired with/without-planes run of the usagov rebuild (the Jain method,
   n=10, applied to our own bring-up script). That experiment would be the
   project's decisive artifact.
2. **Does a 178-test-style outer loop subsume `verify_page`?** Only if someone
   writes the acceptance test for "the page an untested route serves after a
   config import." The verification plane is the standing instrument for the
   unanticipated-write case; tests cover the anticipated one.
3. **Attribution effect vs tool design:** the 23–93-point swing was measured on
   error *text* attribution; our tools provide structured verdicts. Unknown
   whether the effect transfers — but it predicts our tools should beat
   "re-read the file and think" self-checks, which is testable in the paired
   run above.

## Sources

- Jain — https://martinfowler.com/articles/are-harnesses-worth-the-cost.html
- Garg — https://martinfowler.com/articles/orchestrator-tax.html
- OpenAI — https://openai.com/index/harness-engineering
- Böckeler — https://martinfowler.com/articles/harness-engineering.html
- Survey — https://arxiv.org/abs/2606.20683 ·
  https://github.com/Gloriaameng/Awesome-Agent-Harness
- Huang et al. — https://arxiv.org/abs/2310.01798
- Self-Correction Illusion — https://arxiv.org/abs/2606.05976
- Kalai et al. — https://arxiv.org/abs/2509.04664
- AA-Omniscience — https://arxiv.org/abs/2511.13029
- Johansson session — https://www.youtube.com/watch?v=TlFcD3LW8dA
- Buytaert — https://dri.es/friction-abstraction-and-verification ·
  https://dri.es/i-gave-an-ai-agent-edit-access-to-my-website ·
  https://dri.es/do-ai-coding-agents-recommend-drupal-2026 ·
  https://dri.es/ai-rewards-strict-apis
- Drupal AI initiative — https://new.drupal.org/ai/events/Drupal-AI-Summit-New-York-City ·
  https://www.drupal.org/project/ai_learners
