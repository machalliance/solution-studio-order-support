# Savings Opportunity

## WISMO — a chat-only estimate of the human time it could save, and the model cost that comes with it

This page describes an opportunity to test, not a business case. It makes no dollar-savings, payback or return claim, because the figures that decide the answer have not been measured yet. What it offers is a way to estimate **the share of a person's time on in-scope chats that WISMO could possibly save**, the conditions under which that holds, and what to measure in a pilot before anyone repeats a number. Figures taken from published sources are linked under [Sources](#sources); every other figure is an illustrative placeholder, not a measurement. Only chat is modeled: phone and email contacts are out of scope.

> **Everything on this page is an estimate.** The published figures are real, but they are averages from other organizations and may not match yours. Every other input, including the 2.0 minutes a person is occupied per escalated case, is an assumption. The percentages show what those inputs would give if they held for you; they are not measured results and not a forecast.

---

## The idea in one paragraph

WISMO answers the routine post-purchase chats — where is my order, returns, damage and delivery problems — on its own when the policy allows it. When it cannot, it hands a person a case that is already assembled (the conversation, the order facts, the photo and the rule that sent it to a person). The person decides in the Escalation Desk and never has to chat with the customer: the agent keeps the conversation, tells the customer the outcome, and handles whatever the customer asks next. So a person's time on an in-scope chat falls to zero when the agent settles it, and to a short review when it does not. The opportunity is the share of that time which disappears, less the model cost of the conversations the agent handles.

---

## What the published figures can and cannot tell us

| Figure | Value | Used for | Source and how far to trust it |
|---|---|---|---|
| Cost of a person's time per minute | \$0.61 compensation only (sales and office occupations, June 2026: \$36.34 an hour, of which benefits are 28.5%). Built from the customer service representative median wage of \$21.53 an hour (May 2025) it is \$0.50 | Converting minutes to cost | BLS; primary. It leaves out tools, management and space, which are yours to add |
| Length of a chat | 8 minutes 25 seconds on average, and 84.1 chats per agent a day | Length of a routine chat | LiveChat platform data; primary, but one platform across all industries |
| Chats a person runs at once | Usually 2 to 4; 1 to 2 for complex issues; 4 or more for simple order status. LiveChat's own figures imply overlap: 84 chats of 8.4 minutes is 11.8 hours of chat in one day | Turning chat length into the minutes a person is occupied | Vendor guidance and one case study; there is no standard |
| Cost per live contact | \$8.01 for phone, chat or email in 2019, against \$0.10 for self-service | A cross-check only | Gartner poll, read through a reprint; one poll, 2019 dollars, mixed channels, so a chat-only figure should be lower |
| Share of chats that are "where is my order" | No verified benchmark. Vendor estimates run from about 20% to 50% | Share in scope | Use your own ticket tags |
| What an AI agent settles on its own | Vendor-defined and not comparable: early deployments are published at 40% to 60% and mature ones at 60% to 80%, and "contained" overstates "resolved" | Containment | Vendor-published and not independently checked; measure it |
| Minutes to review an escalated case, and a person's time to get up to speed after a handoff | No published figure found. The 2.0 minutes used below is the prototype builder's estimate, not a measurement | Occupied minutes per escalated case (G) and the join-the-chat minutes below | Must be measured |

Two of the numbers that matter most, containment and the minutes a review takes, have no trustworthy published source. That is why this page presents an opportunity and not a forecast.

---

## The estimate

| Input | What it is | Illustrative |
|---|---|---|
| C | **Containment**: share of in-scope chats the agent settles with no person | 50% |
| r | **Minutes a person is occupied by a routine chat today**: chat length ÷ chats at once | 8.4 ÷ 2 = 4.2 |
| h | **Minutes a person is occupied by a chat that needs a person today**: a longer chat, with fewer at once | 12 ÷ 1.5 = 8.0 |
| G | **Total minutes a person is occupied per escalated case with WISMO**: scanning the prepared case and deciding, including any follow-up question and any further decision in the same conversation. The builder's estimate, not a measurement; see [Human time](#human-time-deciding-versus-joining-the-chat) | 2.0 |
| F | **Cost of a person's time per minute**, fully loaded | \$0.61 |
| M | **Model cost per in-scope chat**, see [API cost](#api-cost) | \$0.40 (no caching) or \$0.12 (with caching) |

```
A person's minutes per in-scope chat, today      = C × r + (1 − C) × h
A person's minutes per in-scope chat, with WISMO = (1 − C) × G
Share of a person's time saved                   = 1 − (with WISMO ÷ today)

Cost per in-scope chat, today                    = minutes today × F
Cost per in-scope chat, with WISMO               = minutes with WISMO × F + M
Share of cost saved                              = 1 − (with WISMO ÷ today)
```

### Worked example (illustrative estimates only)

| Line | Calculation | Result |
|---|---|---|
| A person's minutes per in-scope chat, today | 0.5 × 4.2 + 0.5 × 8.0 | 6.1 min |
| A person's minutes per in-scope chat, with WISMO | 0.5 × 2.0 | 1.0 min |
| **Share of a person's time saved** | 1 − 1.0 ÷ 6.1 | **84%** |
| Cost per in-scope chat, today | 6.1 min × \$0.61 | \$3.72 |
| Cost per in-scope chat, with WISMO (no caching) | 1.0 × \$0.61 + \$0.40 | \$1.01 |
| **Share of cost saved (no caching)** | 1 − 1.01 ÷ 3.72 | **73%** |
| Cost per in-scope chat, with WISMO (with caching) | 1.0 × \$0.61 + \$0.12 | \$0.73 |
| **Share of cost saved (with caching)** | 1 − 0.73 ÷ 3.72 | **80%** |

Two of these inputs, G and h, are placeholders with no published source, and they drive the result. Even if every chat escalated (C = 0), the model would still show a saving of 75%, only because a review (2.0 minutes) is assumed to occupy a person far less than a chat they handle themselves (8.0 minutes). Measure both before relying on the percentage.

### How the share of a person's time saved moves

Rows change containment; columns change the total minutes a person is occupied per escalated case (G): 1.5 for a fast reviewer, 2.0 for the estimate, 3.9 for a cautious one and 6.0 for a slow review. Routine and escalated-type chats stay at 4.2 and 8.0 minutes.

| Containment | G = 1.5 min | G = 2.0 min | G = 3.9 min | G = 6.0 min |
|---|---|---|---|---|
| 30% | 85% | 80% | 60% | 39% |
| 50% | 88% | 84% | 68% | 51% |
| 65% | 91% | 87% | 75% | 62% |

### Three scenarios

All inputs illustrative. The low case also assumes people overlap more chats, which makes today's baseline cheaper and the opportunity smaller.

| | Low | Base | High |
|---|---|---|---|
| Containment (C) | 30% | 50% | 65% |
| Chats at once, routine / needs a person | 3 / 2 | 2 / 1.5 | 1.5 / 1 |
| Minutes occupied today, routine (r) / needs a person (h) | 2.8 / 6.0 | 4.2 / 8.0 | 5.6 / 12.0 |
| Minutes occupied per escalated case with WISMO (G) | 4.0 | 2.0 | 1.5 |
| Cost of a person's time per minute (F) | \$0.50 | \$0.61 | \$0.80 |
| **Share of a person's time saved** | **44%** | **84%** | **93%** |
| **Share of cost saved, net of model cost (no caching / with caching)** | **29% / 40%** | **73% / 80%** | **87% / 91%** |

Read the low case plainly: if the agent settles only 30% of chats, a review takes twice as long as estimated, and people overlap many chats, the saving is still 44% of a person's time but only 29% to 40% of cost, because a chat is cheap to begin with and the model has a cost of its own. The opportunity is real only if containment and review time come out near the base case or better.

### What the percentage does not cover

The fixed monthly cost of running the platform and the one-time implementation cost (see [`implementation-guide.md`](implementation-guide.md)) are not in these percentages, and nor is the time operators spend on policy. Whether a percentage covers them depends on your chat volume; at low volume it may not. This page makes no claim about payback.

---

## Human time: deciding versus joining the chat

When the agent cannot settle a chat, a person has to decide, and there are two ways to give them the case. They cost different amounts of human time.

- **Join the chat.** The person is brought into the live conversation, reads what has happened, decides, and then stays to carry the conversation on, answering whatever else the customer asks.
- **Decide in the Desk (WISMO).** The person reads a prepared case and records a decision, optionally with a message to the customer, and is done. The agent tells the customer the outcome and keeps the conversation going, and anything else the customer asks that needs a person becomes a new case.

Containment and the number of escalated cases are the same in both; only the person's minutes differ. Every figure below is a placeholder, per escalated conversation, in the total minutes a person is occupied (not elapsed time).

| | A chat handled entirely by a person | Agent, then the person joins the chat | WISMO: the person decides in the Desk |
|---|---|---|---|
| Chat length, and chats at once | 12 min at 1.5 at once = 8.0 | | |
| Get up to speed (read the conversation so far and the order, find the rule) | included | 2.0 min, full attention | |
| Decide and tell the customer | included | 1.0 min, full attention | |
| Stay in the chat for the rest, including the customer's later requests | included | 3.0 min at 1.5 chats at once = 2.0 | 0, the agent does it |
| Scan the prepared case and decide, including any follow-up question or further decision | | | 2.0 min |
| **Total minutes a person is occupied** | **8.0** | **5.0** | **2.0** |

Joining the chat takes 38% less of a person's time than handling the chat entirely, because the agent has already done the intake. Deciding in the Desk takes 75% less than handling it entirely and 60% less than joining the chat (3.0 minutes). The Desk is quicker because of how the case is presented. The case page leads with a headline and a recommended action, a summary of what the customer is asking for, the order and shipping facts, and the rule that sent the case to a person; the photo and the full conversation sit below, for when they are needed. The person scans a brief and does not have to read the chat, while someone joining a live chat has to read it to get up to speed. Scanning and deciding takes 2.0 minutes in the Desk, against 3.0 for reading the chat and deciding. Even if the cold read took only 1.0 minute, the join total would be 4.0 and deciding in the Desk would still take 50% less.

The table counts a person's time only. In WISMO the agent also keeps the conversation going after the decision, which costs some model calls that do not occur when a person takes over. That is a few turns priced as in [API cost](#api-cost), small next to the minutes saved, but add it to the WISMO column if you want the comparison to be exact.

### Why the minutes differ

- **The case is presented as a brief.** The Desk leads with what the customer is asking for, the order and shipping facts, the rule that sent the case to a person and a recommended action, with the photo and the full conversation below. The person scans a brief instead of reading a chat, which is why 2.0 minutes is plausible against 3.0 for reading the chat and deciding. How long a real person takes is still to be measured.
- **A person in a chat is tied to it.** They cannot leave until the customer has nothing more to ask. Even with other chats overlapping, staying costs about 2.0 occupied minutes in the base case, which deciding in the Desk avoids.
- **Reviews can be batched.** A person can work through several cases in a row, on their own schedule within the response window. A live chat has to be answered when it happens, so the team must be staffed for the peaks of chat traffic.
- **Routine follow-ups stay with the agent.** When a person has joined, the customer's later "where is my package?" is answered by the person. In WISMO the agent answers it, and only a request that needs a person becomes another case.

### What you give up

- **The customer waits for a decision instead of a live person.** The wait is bounded by the response window, which you set, and the customer sees a countdown while the agent keeps the conversation open.
- **A person cannot ask the customer a free-form question live.** They can send one question through the Desk; that takes longer and puts the case back with the customer. The 2.0 minutes is an average that includes it.
- **Some customers want a person.** The agent offers escalation to support when a customer disagrees with a decision. Working those tickets takes human time that this estimate does not include.

### How much the comparison moves

How much less of a person's time deciding in the Desk takes than joining the chat. Rows change the occupied minutes the person would stay in the chat after deciding (the join total is 2.0 + 1.0 plus that); columns change the total minutes WISMO takes per escalated case (G).

| Minutes occupied in the chat after deciding | G = 1.5 min | G = 2.0 min | G = 3.9 min |
|---|---|---|---|
| 1 (join total 4.0 min) | 62% | 50% | 3% |
| 2 (join total 5.0 min, the base case) | 70% | 60% | 22% |
| 4 (join total 7.0 min) | 79% | 71% | 44% |

The break-even is simple: deciding in the Desk wins whenever its minutes (G) are below the join total. With a slow review (3.9 minutes) and a person who would stay in the chat for only 1 minute, the two are almost level; a still slower review would make joining the chat take less.

### What to measure

Run both ways for a time-boxed pilot, for example alternating hours or splitting customers, and record for each escalated conversation:

- the person's total occupied minutes (not elapsed time);
- the time to a decision;
- the number of decisions;
- how often a follow-up question was needed;
- how often the person opened the full conversation and not only the brief;
- re-contact within seven days, and customer satisfaction.

Also record, for chats people handle today, the chat length and how many chats the person runs at once. Then replace r, h, G and the join-the-chat minutes above with the measured figures.

---

## API cost

WISMO calls a large language model on every step of every chat turn, so model cost scales with conversations. The figures below were estimated from the size of the agent's prompt and the shape of recorded conversations in the prototype, **not** from a bill.

- The agent's prompt and tool definitions are about **14,500 tokens**, resent on every model step.
- A turn takes about **2.7 model steps** on average; a median conversation is **3 turns**, and the 90th percentile is 8.

| Conversation | Model steps | Without caching | With prompt caching |
|---|---|---|---|
| Simple tracking question (3 turns) | \~8 | \~\$0.40 | \~\$0.12 |
| A longer chat (8 turns) | \~22 | \~\$1.10 | \~\$0.35 |
| Damage claim with a photo (\~7 turns) | \~20 | \~\$1.20 | \~\$0.40 |

Assumptions (roughly ±40%): Sonnet-class pricing of \$3 / \$15 per million input / output tokens, about 4 characters per token, about 300 output tokens per step. Check current pricing and your own traffic mix before relying on them. Prompt caching is built into the prototype. On one real eight-call conversation it read 80% of its input tokens from the cache and cost about \$0.14 against \$0.40 without it; a longer live session (20 model calls) read 84% of its input from the cache and cost about 72% less. Both are in line with the "with caching" figures here, which remain estimates for other kinds of conversation. The policy-authoring assistant (the Policy Helper) also calls the model, but only when an operator uses it, and it is negligible next to customer traffic.

To model your own mix, take M as the weighted average of the rows above across your expected conversation types. The cost drivers and the ways to reduce them are listed in [`production-considerations.md`](production-considerations.md).

---

## Attribution and Measurement

The arithmetic above is easy; knowing the real inputs is hard. Treat these as risks to the figures.

- **Settled is not the same as resolved.** A conversation the agent closes may produce a second contact a day later. Measure re-contact within seven days for the same order and count it against the saving.
- **Compare against a holdout.** Alternate hours, or split customers between people and WISMO, rather than comparing against last month's totals, so that seasonality and the mix of questions do not pass for a saving.
- **Containment can be bought with the policy.** Letting the agent approve more raises C and the saving, and also raises refund leakage. Report C *together with* the error rate of the automatic decisions, never alone.
- **Automatic declines are a customer-experience risk, not a saving.** The agent declines a non-VIP customer's own-fault damage claim without a person. Track how often those customers push back and how often a rep overturns the decision.
- **Escalated cases are not free.** The agent still creates work. Measure a person's occupied minutes per escalated case, comparing deciding in the Desk with joining the chat (see [Human time](#human-time-deciding-versus-joining-the-chat)), and watch how often the response window is missed.
- **Freed minutes are not savings until staffing changes.** The estimate prices minutes as money. It becomes real only if the minutes are redeployed, or hiring, overtime or contractor hours fall.
- **Return behavior may change.** An easier returns experience can raise the *number* of returns. Include the effect on return volume and on refund spend, not only on contact cost.
- **Learn from the first weeks.** Use the pilot to replace the placeholder inputs with measured ones before you present a forecast.

### Guard-rail check: refund exposure

Estimate the money at risk from wrong automatic approvals alongside the saving:

```
Automatic approvals per month × average refund × error rate
```

Illustrative: 1,000 automatic refunds × \$45 = \$45,000 approved; at a 1% error rate, \$450 a month; at 5%, \$2,250. Compare that with the saving you measure, and with the amount cap (`WISMO_MAX_AUTONOMOUS_AMOUNT`) and the policy's own ceilings, which bound the size of any single automatic approval. Note that the prototype's shipped policy never approves a damage claim automatically, so automatic approvals are limited to plain returns inside the policy's limits.

---

## What this estimate does not include

- The fixed monthly cost of running the platform, the one-time implementation cost, and any claim about payback; see the implementation guide for the work behind them.
- Phone and email contacts. Only chat is modeled.
- Changes in return volume, fraud, or refund spend caused by a different returns experience.
- The cost of the rep tools and any change in headcount, hiring or attrition.
- The human time to work support tickets, which the agent offers a customer who disagrees with a decision, and the time operators spend writing and reviewing policy.
- Customer-satisfaction or retention effects, positive or negative, including the effect of waiting for a decision instead of a live person.
- Provider price changes, model upgrades, and the cost of re-measuring the agent after either.
- Taxes, financing, and any contractual commitments with a model provider.

---

## Methodology notes

- Percentages of a person's time do not depend on volume or on the cost of a minute; percentages of cost also depend on F and M.
- Everything is per in-scope chat, steady-state. For a pilot, run it for the small segment you actually launch to.
- A person's time is counted as total occupied minutes, which for a chat is its length divided by the chats the person runs at once, so a chat that overlaps others costs less than its length.
- The model-cost figures are estimates derived from the agent's prompt size and recorded conversation shapes (conversation length and steps per turn), priced at the rates stated above.

## Sources

Figures read in October 2026. Anything not listed here is a placeholder.

- Cost of a person's time: [BLS Occupational Outlook Handbook, customer service representatives](https://www.bls.gov/ooh/office-and-administrative-support/customer-service-representatives.htm) (median \$21.53 an hour, May 2025) and [BLS Employer Costs for Employee Compensation, June 2026](https://www.bls.gov/news.release/archives/ecec_09092026.htm) (sales and office occupations \$36.34 an hour, benefits 28.5%).
- Chat length and chats per agent: [LiveChat Customer Service Report](https://livechat.com/customer-service-report).
- Cost per contact: [Gartner's 2019 customer service poll, as reported by MacTech](https://www.mactech.com/2019/10/18/gartner-only-9-of-customers-report-solving-issues-via-self-service/).
- Chats at once: [Kustomer's live chat glossary](https://kustomer.com/glossary/live-chat/) and [a 2016 CustomerThink case study](https://customerthink.com/how-many-chat-sessions-can-agents-handle/), both indicative only.
- Share of chats that are "where is my order": [Macha's 2026 ecommerce statistics](https://www.getmacha.com/blog/ecommerce-customer-service-statistics), which notes that no verified benchmark exists, and [Intercom's glossary entry](https://fin.ai/glossary/wismo), which gives about 20% as a common estimate.
- What an AI agent settles: [Intercom's AI resolution rate guide](https://fin.ai/learn/ai-resolution-rate), a vendor's published ranges, not independently checked.
- The per-conversation model costs are estimates from the prototype's own measurements (prompt size, steps per turn, turns per conversation), combined with the pricing assumption stated above.

---

## Disclaimer

This document is a planning aid. It does not predict results, and its illustrative figures should not be quoted as findings. Validate every input against your own data before relying on any output.
