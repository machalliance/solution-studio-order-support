# WISMO — Setup Instructions

This is the full setup guide. For the two-minute version, see the Quick start in the [`README`](../README.md).

---

## Prerequisites

| You need | For | Notes |
|---|---|---|
| An [Anthropic](https://console.anthropic.com) API key | The chat agent and the Policy Helper | Required. Without it the apps start, but every chat message fails. |
| **Node.js 22+** (Linux, macOS or WSL) *or* **Docker** | Running the apps | Pick whichever you already have — same `.env`, same ports. Docker is never required. On native Windows, use Docker: the Desk and storefront scripts use POSIX shell syntax (`${DESK_PORT:-3005}`) that the Windows command shell doesn't understand. |
| **Git** | Cloning the repository | Required for the clone step in the quick start. |
| An OpenAI API key | Regenerating the demo's "damage photos" | Optional. The repository already includes the generated photos, so you only need this if you add new photo scenarios. |

**A real model answers every chat message, so chatting costs money.** Budget roughly \$0.15 for a simple tracking conversation and about \$0.40 for a damage claim with a photo (estimates with prompt caching on, as shipped; without it, about \$0.40 and \$1.20 — see [`production-considerations.md`](production-considerations.md)). Browsing the Escalation Desk makes no model calls; only the chat and the Policy Helper's *Generate proposal* do.

---

## Quick start

```bash
git clone <this-repo>
cd wismo
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env` (the demo customer's and the rep's names in it are placeholders — leave them or change them), then use one of the two paths.

### With Node.js

```bash
npm install
npm run dev     # all three together, logs in one terminal; Ctrl-C stops all three
```

That starts the agent API (`http://localhost:3006`), the Escalation Desk (`http://localhost:3005`) and the storefront (`http://localhost:3007`). If a port is already taken it says so and starts nothing; if one service exits, it stops the others. To run them separately, in three terminals:

```bash
npm run agent:dev
npm run desk:dev
npm --workspace=apps/storefront run dev
```

**Opening the apps from another machine** (a server, or your phone)? In dev mode Next.js blocks its own scripts for any address other than `localhost`, so the pages render but never load their data. Set `DEV_LAN_HOST` in `.env` to the machine's address (`hostname -I`), then restart the two Next.js services. The apps have no login, so do this only on a network you trust. The production-style start below doesn't need this.

All three read the root `.env`. The dev servers hot-reload on code changes — there is no build step. To run without the hot-reload tooling (closer to how Docker runs it), build the two Next.js apps once:

```bash
npm run build --workspace=apps/escalation-desk
npm run build --workspace=apps/storefront
```

then start all three with one command (`Ctrl-C` stops them):

```bash
npm start
```

or each in its own terminal (every `start` command stays running):

```bash
npm run start --workspace=apps/agent             # terminal 1
npm run start --workspace=apps/escalation-desk   # terminal 2
npm run start --workspace=apps/storefront        # terminal 3
```

### With Docker

```bash
docker compose up --build
```

This builds one image and starts three containers from it (agent, Escalation Desk, storefront) on the same ports as above. See [Docker details](#docker-details) below.

### First look

1. Open the **Escalation Desk** (`http://localhost:3005`) → **Settings** → **Reset demo data**. This clears every case and every stored chat conversation and creates the demo set (see [Demo data](#demo-data)); it takes a few seconds. A storefront chat window left open across a reset still shows its old messages but the agent no longer remembers them, so reload the page. You can also run `npm run agent:seed` from the repo root.
2. Open the **storefront** (`http://localhost:3007`) and click the chat button.
3. Keep both open: a rep's decision in the Desk appears in the customer's chat live.

---

## Environment variables

`.env.example` is the authoritative, commented list. Two things are **required**: `ANTHROPIC_API_KEY`, and the three identity values in [Demo identity and currency](#demo-identity-and-currency) (the agent won't start without them; `.env.example` supplies placeholders). Everything else is optional; values shown are the defaults.

### Model providers

| Variable | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required.** Powers the chat agent and the Policy Helper. |
| `OPENAI_API_KEY` | — | Optional. Used only by `npm run agent:seed` to synthesize a customer's "damage photo" for seeded scenarios that need one, and only for a photo that isn't already cached in `apps/agent/data/damage-photos/`. It costs a little real money per new photo and is skipped quietly if unset. |
| `WISMO_CHAT_MODEL` | `anthropic/claude-sonnet-4-5` | The model for both the chat agent and the Policy Helper. A free-text model id; changing it needs an agent restart. Prompts were written and checked against the default — measure before you trust another model with fault or escalation judgments. The prompt-caching setting is written for Anthropic models. |

### The agent

| Variable | Default | What it does |
|---|---|---|
| `AGENT_PORT` | `3006` | Port the agent API listens on. |
| `AGENT_DB_URL` | `file:./mastra.db` | The LibSQL database: workflow runs (which *are* the escalation queue), traces, and policy history. A relative path is relative to `apps/agent/`. Docker overrides this so the file lives in its data volume. |

### Demo identity and currency

The code ships with **no** names or addresses for the customer or the rep: they come only from `.env`, and the agent refuses to start if any of the three below is missing. `cp .env.example .env` gives you working placeholders; use any names you like.

To change a name later: edit `.env`, restart the agent (`docker compose up -d` if you use Docker), and reload the page. The agent reads `.env` only when it starts, and the names are looked up each time they are shown, so there is nothing stored to refresh — **Reset demo data** is not needed for it.

| Variable | Default | What it does |
|---|---|---|
| `WISMO_DEMO_CUSTOMER_NAME` | **required** (`.env.example`: `John Smith`) | The one "logged in" customer the storefront starts with. |
| `WISMO_DEMO_CUSTOMER_EMAIL` | **required** (`.env.example`: `john.smith@example.com`) | Where the stubbed customer notifications say they were sent. |
| `WISMO_REP_NAME` | **required** (`.env.example`: `John Doe`) | The support rep shown as logged in at the top of the Escalation Desk. There is no real login. |
| `WISMO_CUR` | `USD` | ISO 4217 currency code. Every order amount, refund and threshold is in this unit, and it is the only place currency is decided. |

### Business-configurable values

These are settings, not code. The two response-window values and the spending ceiling can also be changed live from the Desk's **Settings** page, but those live changes reset when the agent restarts. **What actually decides a case** — the return window, the refund ceilings, and the switches that turn automatic decisions on or off — is *not* here: it lives in the policy document on the Desk's **Policies** page, which is saved and versioned.

| Variable | Default | What it does |
|---|---|---|
| `WISMO_HIGH_PRIORITY_THRESHOLD` | `250` | An escalated refund or return above this amount is marked high priority and sorts first in the queue. `0` turns amount-based flagging off. Delivery disputes are always high. Sorting only — it never changes a decision. |
| `WISMO_ESCALATION_SLA_MINUTES` | `5` | How long a specialist has to respond, or a customer has to answer a specialist's question, before the case is ticketed automatically. |
| `WISMO_SUPPORT_TICKET_CONTACT_HOURS` | `24` | What the customer is told to expect once a case has been ticketed. |
| `WISMO_MAX_AUTONOMOUS_AMOUNT` | `500` | The one limit outside the policy document: no *automatic* approval above this amount, whatever the policy says. `0` stops every automatic approval — an emergency brake that needs no policy edit. A rep's own approval is not capped by it. |

**Two ways to stop automatic decisions, for different jobs.** `WISMO_MAX_AUTONOMOUS_AMOUNT` (or the same field on the Settings page) is the emergency brake: set it to `0` and nothing is *approved* automatically, but automatic *declines* still happen. The policy's own master switch, `autonomousRefundsEnabled` on the Policies page, is the broader one: turned off, **every** refund, return and dispute goes to a person — approvals and declines alike. (`autonomousPlainReturnsEnabled` does the same for plain returns only.)

### Ports and networking

| Variable | Default | What it does |
|---|---|---|
| `DESK_PORT` | `3005` | Escalation Desk port. Docker reads it from `.env`. **Running natively, also export it in the shell that starts the Desk** (`DESK_PORT=3015 npm run desk:dev`): the Next.js scripts read the shell, not `.env`. Keep `.env` in step too — the agent reads it to decide which browser origins it allows. |
| `STOREFRONT_PORT` | `3007` | Storefront port. Same rule as `DESK_PORT`: Docker reads `.env`; natively, export it too (`STOREFRONT_PORT=3017 npm --workspace=apps/storefront run dev`). |
| `NEXT_PUBLIC_AGENT_PORT` | `3006` | The agent port the **browser** calls. Both front ends derive the agent's address from the hostname you used to reach *them* plus this port, so a phone on your LAN works with no extra setup. It is baked in when the Next.js apps are built — in Docker, compose passes `AGENT_PORT` for you. |
| `NEXT_PUBLIC_AGENT_URL` | — | An override for a genuinely different agent host (for example behind a reverse proxy). Leave it unset otherwise. Also baked in at build time. |
| `DEV_LAN_HOST` | — | Testing from a phone or another machine in development: Next.js dev mode blocks cross-origin access to its own dev files unless the origin is listed. Set this to the machine's LAN IP (`hostname -I`). |
| `DEV_PUBLIC_HOST` | — | The same, for a public hostname the dev servers are reached through (for example behind a reverse proxy). Leave blank unless you do that. |

---

## Docker details

```bash
docker compose up --build        # build and start all three
docker compose logs -f agent     # follow one service
docker compose down              # stop; the data volume is kept
docker compose down -v           # stop AND delete the data volume — a clean slate
```

- **One image, three containers.** Agent, Desk and storefront run from the same image, each with its own command; the Desk and storefront wait for the agent's health check.
- **One data volume**, `agent-data`, holds the agent's database, the policy versions and the support-ticket record, so they survive a container being recreated. The volume is filled from the image the first time it is created; a newer image does **not** overwrite an existing volume. To pick up shipped data changes (or just reset), run `docker compose down -v`.
- **Secrets stay out of the image.** `.env` is excluded at build time and your keys reach the containers at run time. The container runs as an unprivileged user.
- **Ports.** `AGENT_PORT`, `DESK_PORT` and `STOREFRONT_PORT` in `.env` are respected. Because the browser's agent address is baked in when the Next.js apps are built, rebuild (`docker compose up --build`) after changing `AGENT_PORT`.
- **Size.** The image carries the runtime dependencies of all three apps. Run `docker images` to see its size on your machine.

---

## Demo data

The customers, orders, products and carrier records are fictional.

**The logged-in customer** has five orders. Delivery dates are relative to when the agent started, so "delivered 3 days ago" stays true.

| Order | Items | Notes |
|---|---|---|
| `#2001` | Adventure Merino Crew Socks — \$19.99 | Single item. Good for a plain return. |
| `#3401` | Camp Slip-On Shoe — \$70 | The delivery-dispute scenario ("shows delivered, never arrived"). |
| `#1181` | Canvas Chore Jacket — \$165 | A damage-claim scenario. |
| `#4203` | Pants \$125, socks \$19.99, belt \$45 | Three items — try returning two of them in turn. |
| `#4472` | Merino Crew Neck Sweater \$85, Packable Rain Shell \$145 | Delivered about 30 days ago, so right at the edge of the return window. |

After **Reset demo data**, orders `#1181` and `#3401` already have an open case in the queue (so the agent reports its status instead of opening another); `#2001`, `#4203` and `#4472` are untouched. The reset also seeds a case for each of four other customers — a torn rain shell, a broken duffel zipper, a VIP customer who damaged an item themselves, and a split sneaker sole — so the Desk has a realistic queue to look at. The damage cases come with a synthesized damage photo.

Seeded cases are ticketed automatically after the response window (5 minutes by default) while the Desk is open. That is the normal timeout behavior, not a fault; raise `WISMO_ESCALATION_SLA_MINUTES` if you want them to stay open while you look around.

---

## Running the demo

A walkthrough that exercises each part. Chat steps cost real model calls.

1. **Where is my order?** In the storefront chat, ask. Pick `#2001`. The agent looks up the order and the carrier record and answers with the status, who signed, and a tracking link.
2. **A return that approves itself.** Say you want to return the socks from `#2001`. It is inside the policy's window and ceilings, so it is approved on the spot and you get a return label. A case is still recorded, but it resolves immediately without waiting for a person: in the Desk, **History** shows it as resolved by the agent, with the policy rule that allowed it.
3. **A second return on the same order goes to a person.** On `#4203`, return the socks, then start a new chat and return the belt. The policy allows one refund per order, so the second request is escalated; the customer is told a specialist will review it and a countdown appears.
4. **A damage claim.** On `#4472`, say the rain shell is damaged and *not* your fault, and attach a photo (the paperclip, or paste an image). The agent takes the photo and escalates — damage that isn't the customer's fault always needs a person to look at the photo.
5. **Be the rep.** Open that case in the Desk. You'll see the transcript, the photo, the rule that sent it to a person, and the decision bar: **Approve**, **Reject**, **Modify** (a different amount), **Request more info**, or **Escalate to support**. Approve or Modify with a *Message to the customer* — it is shown in their chat and included in the email, and it is recorded in the case's resolution. Watch the chat update live.
6. **An automatic decline, and disagreeing with it.** Report damage on another item and say you caused it yourself (for example, that you snagged it on a fence). Under the shipped policy, for a non-VIP customer that is declined automatically (a VIP's goes to a person). Push back in the chat and the agent offers to escalate to support; accepting opens a support ticket. (Describing damage that happened during ordinary use — "it tore while I was wearing it" — is treated as *not* your fault and goes to a person.)
7. **Change the rules.** Open **Policies**. The live policy is shown in plain English: restrictions (any one sends a case to a person), the few automatic decisions, and the fallback. In the Policy Helper, describe a change — for example, *"Any return over \$15 must go to a specialist."* — review the proposal, and use the draft editor's **Validate & Save**. The new version applies immediately. If you write a rule's *reason code* yourself, make it distinctive (for example `exceeds-return-limit`), not an everyday phrase like `follow-up`: reason codes are internal, so the chat swaps any reply that contains one for a neutral line. To see it work, reset the demo data and repeat step 2: the socks (\$19.99) are now over the limit, so the same return goes to a person instead of being approved on the spot. **Version history** lets you revert to any earlier version (a revert is saved as a new version; nothing is deleted).

---

## Tests

```bash
npm test                                         # all tests, from the repo root; none of them call a model
npm run typecheck --workspaces --if-present      # type-check all three apps
```

If you edit the live policy, a few tests that rely on its rules (the money step, the demo seed) may fail. That is them noticing the change, not a bug.

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| The agent exits at start with **`Not set in .env: WISMO_DEMO_CUSTOMER_NAME, …`** | The customer's and the rep's names have no built-in default. Copy those lines from `.env.example` into `.env` (or `cp .env.example .env`) and start again. |
| Chat shows **"I'm sorry, something went wrong on our end"** with a **Try again** button | The agent couldn't reach the model provider. It retries a failed call up to four times over about 15 seconds before giving up; a short outage usually clears on **Try again**. Look for `Upstream LLM API error` in the agent's log. |
| Chat shows **"I'm sorry, I can't help with this right now. Please try again later."** and no button | The provider is refusing requests and retrying won't help — most often a missing or invalid `ANTHROPIC_API_KEY`, no credit left, or a spending limit reached. Check the key and the provider's billing page. |
| A photo is refused: **"That photo is over 7 MB and in a format we can't shrink"** or **"We can't read that file as a photo"** | The chat shrinks large photos in the browser before sending. This message means the browser couldn't decode the file *and* it was too big to send as is — use a JPG or PNG. |
| **"I couldn't open that photo…"** | The model provider rejected the image itself. Send a different photo. |
| Model cost is higher than the estimates | The estimates assume prompt caching is working. The cache lasts about five minutes and is written again after any edit to the prompt or tools, so the first message after a quiet period or a deploy is billed at the full price once. A long run of calls with no cache reads in the traces means the prompt is changing between calls, or the model isn't from Anthropic; see lever a in [`production-considerations.md`](production-considerations.md). |
| `npm install` ends with **"8 moderate severity vulnerabilities"** | Expected. They are one dependency chain inside the agent framework (`sprintf-js`), with no fixed release available yet, and no customer input reaches it. Don't run `npm audit fix --force`: it would downgrade the framework. |
| The Desk queue is empty | Run **Settings → Reset demo data** (or `npm run agent:seed`). |
| Seeded cases turned into "escalated to support" on their own | The response window passed (5 minutes by default) while the Desk was open. Expected; raise `WISMO_ESCALATION_SLA_MINUTES`. |
| The agent answers for an order but says it "already has a case" | One open case per item. Reset the demo data, or use an order with no case (see [Demo data](#demo-data)). |
| `address already in use` | Another process has port 3005/3006/3007. Stop it, or pick other ports: set `DESK_PORT` / `STOREFRONT_PORT` / `AGENT_PORT` in `.env`, and for the native Desk and storefront also export them in the shell that starts them (for example `DESK_PORT=3015 npm run desk:dev`). In Docker, `.env` alone is enough, but rebuild after changing `AGENT_PORT`. |
| Docker: state from an earlier run is still there | The data lives in a volume that survives restarts. `docker compose down -v` wipes it. |
| Docker: a newer image didn't change the demo data | An existing volume is never overwritten by a new image. `docker compose down -v`, then `up --build`. |
| The storefront or Desk loads but nothing fills in | The browser can't reach the agent. It uses the page's hostname plus `NEXT_PUBLIC_AGENT_PORT`; behind a proxy or on another host, set `NEXT_PUBLIC_AGENT_URL` and rebuild. |
| Opened from another machine or a phone: the pages render but show **no data** (empty storefront, an empty Desk queue even after a reset, stuck on loading). The Next.js log says **`Blocked cross-origin request to Next.js dev resource`** | Set `DEV_LAN_HOST` to your machine's LAN IP and restart the Next.js dev servers. |
| A policy change doesn't save | The editor lists the validation problems it found; nothing is saved until the document is valid. A draft based on an out-of-date version is rejected — reload and re-apply. |
| Changes you made on the Settings page disappeared | Those values are held in memory and reset on restart; set the matching `WISMO_*` variable in `.env` to make one permanent. |
