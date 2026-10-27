# Implementation Guide

## WISMO — Prototype to Pilot Backlog

This guide is a sequenced backlog for moving WISMO from a working prototype to a production-adjacent pilot: real customers on a real retailer site, real order, carrier, payment and ticketing systems behind the agent, and real reps working the queue. Tasks are grouped into five phases. Each task carries a scope and priority in the format (Scope · Priority) — scope runs Small (a day or less), Medium (two to five days), Large (one to two weeks), or Extra Large (more than two weeks); priority is Required or Recommended. Dependencies are noted inline.

"Production-adjacent" means: real data, real integrations, close monitoring, a limited customer segment — but not full hardening on every dimension at once. The goal of a pilot is to learn how the agent behaves with real customers and real orders, and what share of cases it can settle safely, before committing to a broader rollout.

**What to keep.** The valuable parts of the prototype are the *autonomy gate* (a versioned policy document, evaluated by deterministic code, that decides which requests may be settled without a person), the *human-in-the-loop queue* (a suspended workflow that a rep's decision resumes), and the rule that the model never decides money. The work below replaces the fixtures and stubs *behind* those, not the pattern itself.

This is the execution plan. For the briefing on what the prototype does and does not address — written for the person deciding whether to invest — see [`production-considerations.md`](production-considerations.md).

---

## Phase 1 — Security and Infrastructure
*Prerequisite work before this is reachable by real customers or real reps.*

---

### Identity and access

**1.1.1 — Authenticate Escalation Desk users** (Large · Required) The Desk has no login: the rep is a single configured name (`WISMO_REP_NAME`) shown in the header, and a decision records no reviewer identity. Put it behind your single sign-on, record the actual rep on every decision, and show them in the case history.

**1.1.2 — Separate who can decide cases from who can change the policy** (Medium · Required) The Policies page can change how every future case is decided. Give it its own role, distinct from the reps who work the queue. *Depends on 1.1.1.*

**1.1.3 — Bind the chat to an authenticated customer** (Medium · Required) The prototype's customer is a fixed demo identity. In production the storefront's verified session must supply the customer id to the agent server-side — the agent already treats the customer id as trusted server data and never takes it from the conversation, so this is a matter of where it comes from, not a redesign. The server also keeps each conversation under a `sessionId` the browser chooses, so tie a thread to the authenticated customer; holding a conversation id should not be enough to continue someone's chat.

**1.1.4 — Demo defaults out of the code** (Done in the prototype) The demo customer's name and email, the rep's name and the development-host allow-list come from configuration (`.env`), with no value baked into the source; the agent refuses to start without the three identity values. What remains is real authentication and reviewer attribution (1.1.1–1.1.3).

### Network and abuse

**1.2.1 — TLS and network exposure** (Medium · Required) Terminate TLS in front of all three services, and do not publish the agent, Desk or storefront ports directly. The browser calls the agent at the page's own hostname plus a port; behind a proxy set `NEXT_PUBLIC_AGENT_URL` and rebuild (the value is baked into the Next.js build).

**1.2.2 — Restrict cross-origin access** (Small · Required) The agent allows any origin on the Desk and storefront ports. Replace that with an explicit allow-list of the real front-end origins.

**1.2.3 — Rate limit the chat endpoint** (Medium · Required) Every chat message is a paid model call. The prototype allows one running turn per session, which only stops a double send: the browser chooses its own session id, so a script that sends a new id with every request is not limited by it, and each new id starts a new stored conversation. There is no per-address or per-customer limit. Add limits per client and per customer, with a clear customer-facing message when one is hit. *Depends on 4.2.3. Related: 1.2.4.*

**1.2.4 — Limit what a request and a conversation can hold** (Small · Required) The prototype leaves all of this open on purpose. Limit photos, not the chat: about 4 MB per photo, about 5 photos per conversation (4 per message), and a request cap as a backstop (about 32 MB while the widget resends the whole chat with every message, about 25 MB if it sends only the newest). Each refusal says why and text keeps working, and the widget applies the same limits when a photo is attached so the customer is told before sending. Know the trade-off: once a chat has used its five photos a rep cannot ask for another in it; if that matters, send the model only the newest photos and keep all of them stored. *Related: 3.4.1.*

### Persistence and scale

**1.3.1 — Move the database to a managed, backed-up store** (Medium · Required) Workflow runs (which *are* the escalation queue), traces and policy history live in one LibSQL file. Use a managed database, take backups, and decide a retention period for finished runs and traces — the file grew to hundreds of megabytes during development.

**1.3.2 — Persist the runtime settings** (Small · Required) The response windows and the autonomous-amount ceiling are held in memory and reset on restart. Store them (the Desk's Settings page already reads and writes them) so a restart does not quietly change behavior.

**1.3.3 — Replace the in-process event emitter with a message bus** (Large · Required before running more than one agent instance) Live updates to a customer's open chat come from an in-process emitter, so the agent must run as a single process. A shared bus (for example Redis pub/sub) lifts that. Until it is done, do not scale the agent service beyond one instance.

### Deployment

**1.4.1 — Build, scan and publish the image in CI** (Medium · Required) The repository's container image builds the three services from one Dockerfile. Rebuild it on a schedule to pick up base-image patches, and scan every build with Trivy (image mode) and Grype. See the container section of [`production-considerations.md`](production-considerations.md) for what the current scans leave.

**1.4.2 — Secrets management** (Small · Required) Keys reach the containers from an `.env` file. Move the model provider keys to a secrets manager.

---

## Phase 2 — Data and Integration
*Replace the local fixtures with the real systems, behind the same interfaces.*

---

### Order and customer data

**2.1.1 — Order and customer adapter** (Large · Required) Replace the fixture orders and customers with your order system. Every gating fact the policy uses — order amount, delivered date, refund history, VIP status — must come from here, never from the conversation.

**2.1.2 — Validate order data before it reaches a decision** (Medium · Required) The prototype trusts order data as given; a delivery date in the future, for example, would be evaluated as is. Validate records at the adapter and treat an invalid field as *unavailable* — the policy engine already sends a case to a person when a fact it needs is unavailable, so the goal is to make bad data take that path instead of a wrong one.

**2.1.3 — Carrier tracking adapter** (Medium · Required) Replace the fixture carrier records with live tracking. The delivery-dispute flow depends on the carrier record and the customer's account disagreeing, so its accuracy and freshness matter.

### Money

**2.2.1 — Refund execution with a completion signal** (Large · Required) The prototype only records that a refund was *approved*; it never learns that money moved. Integrate the payment or order system to issue the refund idempotently, and consume its completion event. Today's "completed refunds" history in the policy is fixture data until this exists — until it does, treat any rule that depends on completed refunds as unreliable.

**2.2.2 — Return labels and RMA** (Medium · Required) Replace the generated label link with your returns provider, and decide whether an approved refund should wait for the item to be received (the prototype pays out immediately).

### Case handling and customer contact

**2.3.1 — Ticketing integration** (Medium · Required) Escalated-to-support and timed-out cases open a stubbed ticket (logged, with a made-up id). Create real tickets, and sync status back so the agent can answer "what happened to my ticket" truthfully.

**2.3.2 — Notification provider** (Medium · Required) Customer notifications are a stubbed email. Choose a provider, add templates and per-customer channel preference, and handle bounces. The agent function already takes a customer id, not an address, so providers can be swapped without touching callers.

**2.3.3 — Catalog and product images** (Medium · Recommended) The item picker shows each item's photo and price from the catalog fixture. Connect your catalog.

---

## Phase 3 — Agent Quality, Safety and Cost
*Making the agent's behavior something you can measure and change safely.*

---

### Measurement

**3.1.1 — An evaluation harness for the agent's judgments** (Large · Required) Two statements with the same meaning can produce opposite decisions: "it tore while I was wearing it" and "it tore during normal wear" must be judged the same way. A difference is caught by running full scripted conversations and recording what the agent *decided*, not by reading a diff. Turn that into a standing suite run on every prompt, tool or model change, covering fault attribution, escalation, and refusal behavior. Budget its model cost explicitly.

**3.1.2 — Track the outcomes the model influences** (Medium · Required) Fault attribution is the model's reading of the customer's words and is never verified, and an own-fault claim from a non-VIP customer is declined automatically. Track how often those automatic declines are disputed and overturned, and review them regularly. *Depends on 4.2.1.*

### Cost

**3.2.1 — Prompt caching** (Done in the prototype · confirm the saving at your volume) The \~14.5k-token prompt is resent on every model step, so the agent marks it cacheable, the largest single saving, with no change in behavior. Measured on one real eight-call conversation: 80% of the input tokens came from the cache and the model cost fell by about two thirds; a 20-call live browser session gave 84% and a 72% saving, and a second chat read the cache the first had written. Keep customer-specific data out of the cached prompt and tools, and watch the cache fields in the traces. See the cost section of [`production-considerations.md`](production-considerations.md) for what to change and test.

**3.2.2 — Model strategy** (Medium · Recommended) Make the model a runtime-switchable, per-task setting rather than one environment variable, and evaluate a cheaper model for low-risk turns such as order tracking. Do not move fault or escalation judgments to another model without 3.1.1 in place. The prompt-cache marker is written for Anthropic models, so a model from another provider needs its own caching setting (3.2.1).

### Safety and governance

**3.3.1 — Policy change governance** (Large · Recommended) Operators can author and activate policy, and a saved version applies at once. For production add review and approval for changes, an audit trail of who changed what, a description of each save's actual changes, and a way to try a policy against sample requests before it is live.

**3.3.2 — Keep the leak guard in step with the policy** (Done in the prototype) The reply guard reads the live policy's reason codes on every reply, so a rule added on the Policies page or accepted from the Policy Helper is covered the moment it is saved, in any style (kebab, snake, dotted, camelCase, any letter case). A fixed list still covers the codes the code itself produces, and a test fails if one is missing. What remains: a code that is a single plain word ("review") or an all-caps word cannot be told apart from ordinary prose, so it is not blocked; and the opposite case, a code that is an everyday hyphenated phrase ("follow-up"), makes any reply containing that phrase fall back to a neutral line (logged on the server). For production, validate reason codes at save time to a distinctive format instead.

**3.3.3 — Close the unverifiable-claim gap** (Medium · Recommended) A guard checks that amounts, timeframes, dates and ids in a reply come from tool results, but it cannot catch a claim with no number in it ("it has already been processed"). Evaluate a small judge model for those claim types, run in log-only mode first.

**3.3.4 — Test the agent against hostile customers** (Medium · Recommended) The server keeps the conversation and cleans each new message's structure, but it cannot remove an instruction written in plain English by the customer who typed it. Build a suite of adversarial conversations (an instruction override, made-up system text, role play, a request for another customer's data, coaxing a refund amount or a fault statement) and run it with the 3.1.1 harness before launch and after every prompt or model change. Score each by what it decides (a refund, a case, a ticket), not only by what the agent says. The prototype's tests already drive a model that obeys every instruction through the real route; the same cases run against the real model before and after each prompt change are the rest of this task.

**3.3.5 — Finish the turn after a failed lookup** (Done in the prototype · confirm on your model) A lookup that fails after the agent's opening line is answered: the error goes back to the model as the tool's result, and a step that did real work is always followed by a step that must reply. The turn still ends at once for a tool that does not exist or a failing model service. Check it with the 3.1.1 suite on your model: a mistyped order number and another customer's order should each get a plain answer.

### Photos and data

**3.4.1 — Store photos outside the workflow state** (Medium · Required) A customer's photo is embedded in the case record, which inflates storage. Store photos in object storage and keep a reference. Validate type, size and content on the server as well as in the browser; the prototype already reads a photo's real type from its bytes and caps the size and number of photos on the server. A photo a customer sends is also kept in the stored conversation thread, so the same storage applies there.

**3.4.2 — Privacy, retention and deletion** (Medium · Required) Customer names, emails, photos and conversations live in workflow runs, traces and the stored chat threads (`wismo_threads`, which nothing expires). Decide what is retained, for how long, and how a deletion request is honored. Review the fields masked in traces. Conversations and photos are also sent to the model provider, and a photo can carry location and device details inside the file; see production considerations, section 5.

---

## Phase 4 — Observability and Operations

---

**4.1.1 — Structured logging with correlation ids** (Small · Required) Log with the case id and session id on every line, and keep the model's own request ids.

**4.2.1 — Business metrics** (Medium · Required) Containment (resolved with no person), escalation rate, time to first rep response, share of cases that hit the response window and were ticketed automatically, reopen and dispute rates, and refund amounts by decision path.

**4.2.2 — Reliability metrics and alerts** (Medium · Required) Model error and retry rate, latency per turn, and queue depth and age. Alert before the response window is routinely missed.

**4.2.3 — Spend monitoring** (Small · Required) Track cost per conversation and per day, alert on a budget, and set a provider-side spending limit. The agent already shows customers a safe "I can't help with this right now" message, with no retry offered, when the provider refuses requests for a cap or credential reason.

**4.3.1 — Runbooks** (Small · Recommended) Provider outage, spending cap reached, queue backlog, and "turn off automatic decisions now" (the autonomous-amount ceiling set to 0 stops every automatic approval without a policy edit).

---

## Phase 5 — Pilot Operations and Tuning

---

**5.1.1 — Scope and rollout** (Medium · Required) Start narrow: one customer segment and the "where is my order" intent first, with returns next and damage and dispute handling last. Decide in advance the thresholds at which you widen or roll back.

**5.1.2 — Define success** (Medium · Required) Agree the measures before launch: containment, customer satisfaction on resolved chats, rep handling time on escalated cases, refund leakage, and the overturn rate of automatic declines. Set a comparison group; see the attribution notes in [`business-case-template.md`](business-case-template.md).

**5.1.3 — Rep onboarding and queue operations** (Small · Required) Train reps on the case page, the decision options and the customer-message field (what they write there is sent to the customer), and staff the queue to the response window.

**5.1.4 — A policy tuning loop** (Medium · Recommended) Review escalated and denied cases with support and finance on a cadence, and adjust the policy document deliberately rather than ad hoc.

---

## Testing and CI

**6.1 — Continuous integration** (Medium · Required) On every change: type-check all three apps, run `npm test`, and run the static and dependency scans (fallow, Semgrep, Trivy). Build and scan the image on a schedule.

**6.2 — Adapter contract tests** (Medium · Required) Each integration in Phase 2 gets a test that runs the same checks against the fixture and the live implementation, so the two stay interchangeable.

**6.3 — A scheduled agent evaluation run** (Medium · Recommended) Run the 3.1.1 suite on a schedule with a fixed budget, and alert on drift in how the agent decides.

---

## Sequencing Summary

| Phase | Theme | Main dependencies |
|---|---|---|
| 1 | Identity, network, persistence, deployment | None — start here |
| 2 | Real order, carrier, payment, ticketing and notification integrations | Phase 1 identity and secrets |
| 3 | Measure the agent's judgments, control cost, govern the policy, protect data | Phase 2 data for realistic evaluation |
| 4 | Observability and operations | Runs alongside 2–3; metrics need 2.1 and 2.2 |
| 5 | A narrow pilot, then widen | Phases 1–4 |

Within Phase 1, authentication (1.1.1–1.1.3) and TLS (1.2.1) are gating: nothing else should be reachable by real users until they exist. 3.1.1 should be started early, because every later change to the agent is safer with it.

---

## What Is Out of Scope for a Pilot

- Native mobile apps (both front ends are responsive web)
- Languages other than the one the prompts are written in, and voice
- Proactive outbound messages (shipping delay notices, for example)
- Cart or checkout
- Multi-region or multi-tenant deployment
