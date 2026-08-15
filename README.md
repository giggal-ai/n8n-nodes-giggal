# n8n-nodes-giggal

Community [n8n](https://n8n.io) node for [Giggal.ai](https://giggal.ai), the catch-all email verifier that returns clear valid or invalid results for the addresses standard verifiers give up on.

Add Giggal.ai to any n8n workflow and verify catch-all, accept-all, and SEG-protected email addresses (Proofpoint, Mimecast) with deep mailbox verification. Your bounce rate stays under 3%, and the 30% of every B2B list that other tools flag as risky or unknown becomes deliverable again.

<p align="center">
  <img src="https://raw.githubusercontent.com/giggal-ai/n8n-nodes-giggal/main/nodes/Giggal/giggal-logo-wordmark.png" alt="Giggal.ai — Verify Catch-All, Accept-All, and SEG-Protected Emails" width="320"/>
</p>

---

## Why Giggal.ai

Most email verifiers stop at a basic SMTP ping. Catch-all domains come back as risky, SEG-protected addresses come back as unknown, and 30% of every B2B list gets thrown away when it did not need to be.

Giggal.ai is a purpose-built [catch-all email verifier](https://giggal.ai) that goes further:

- **Verifies catch-all and accept-all mailboxes** on domains that reject standard SMTP probes, using deep mailbox verification instead of surface heuristics.
- **Bypasses secure email gateways** like Proofpoint and Mimecast, confirming the real mailbox behind each address instead of returning unknown.
- **Returns a clear valid or invalid verdict** for every address, so your workflow logic stays simple and your CRM stays clean.
- **Keeps bounce rate under 3%** across cold email, drip sequences, and transactional pipelines.

Read more about how [catch-all email verification](https://giggal.ai) works and why it matters for B2B pipelines at [giggal.ai](https://giggal.ai).

---

## Installation

Once available on the npm registry, install directly from your self-hosted n8n instance:

1. Open **n8n → Settings → Community Nodes**.
2. Click **Install a community node**.
3. Enter `n8n-nodes-giggal` and click **Install**.
4. Reload n8n. The **Giggal.ai** node appears in the node picker.

**Note:** Community nodes are only supported on self-hosted n8n. n8n Cloud does not currently allow custom community nodes.

---

## Credentials

1. Sign in at [emailverifier.giggal.ai](https://emailverifier.giggal.ai).
2. Open the **Developer API** tab and create a new API key.
3. In n8n, add a new **Giggal.ai API** credential and paste the key.
4. Save. n8n calls `GET /v1/credits` to validate the key. A green checkmark means it works.

The key is sent as `Authorization: Bearer <key>` on every request. It is stored encrypted by n8n and never leaves your instance.

---

## Operations

### Email → Verify

Verifies a single email address per input item using Giggal.ai's deep mailbox verification pipeline.

- **What it does**: runs a full mailbox existence check including catch-all, accept-all, and SEG-protected mailboxes (Proofpoint, Mimecast). Standard verifiers return risky or unknown for these addresses. Giggal.ai returns a clear **valid** or **invalid** result.
- **Cost**: 1 Giggal.ai credit per call.
- **Processing Mode**:
  - **Sequential** (default): one at a time. Respects `Continue On Fail`. Recommended for large lists.
  - **Batch**: all input items in parallel. Faster but may hit the 300 req / 15 min rate limit.
- **Returns**: the full verification payload from the [Giggal.ai Developer API](https://giggal.ai), including `is_valid`, deliverability score, MX records, catch-all detection, disposable / role-account flags, and blacklist findings.

### Email → Verify Batch

Submits many email addresses as a single asynchronous batch job. Every input item to the node is bundled into one API call, so this scales cleanly to large lists.

- **What it does**: pulls the email from every input item (using the field name you specify), submits one batch job, and returns the `jobId` immediately. Pair with **Job → Get Status** and **Job → Get Results** to fetch the outcome.
- **Catch-All Rescue is on by default**, so catch-all, accept-all, and SEG-protected addresses get real valid/invalid verdicts instead of the risky/unknown you would get elsewhere.
- **Cost**: 1 credit per email verified.
- **Idempotency Key** (optional): pass a unique key to make retries safe. Reusing the same key returns the existing job instead of creating a new one.
- **Returns**: `{ data: { jobId, status, totalEmails, ... }, meta: { acceptedEmails, rejectedEmails, duplicateEmails, invalidEmails } }`.

### Job → Get Status

Returns the current status of a batch verification job.

- **Input**: `Job ID` from a prior Verify Batch call. Typically mapped with `{{ $json.data.jobId }}`.
- **Returns**: `status` (queued / processing / completed / failed), progress counters, and job metadata.
- **Use case**: poll after Verify Batch until `status === "completed"`, then call Get Results.

### Job → Get Results

Returns the per-email verification results for a batch job, expanded into individual n8n items (one output item per email result).

- **Input**: `Job ID`, plus optional `Page`, `Limit` (max 500), and `Status Filter`.
- **Returns**: N output items, one per email result on the requested page. Job + pagination metadata is attached to each item under the `_giggal` key so downstream nodes can read `_giggal.pagination.total`, `_giggal.job.status`, etc.
- **Result retention**: 48 hours after job completion. Older jobs return a 410 Gone error.

### Account → Get Credit Balance

Returns the current available credit balance for the Giggal.ai account tied to the API key.

- **Cost**: free.
- **Use case**: gate expensive verification runs on remaining balance, or alert your team when credits fall below a threshold.

---

## Usage examples

### Verify emails from a webhook and route on the result

```
[Webhook] → [Giggal.ai: Verify Email] → [Switch on is_valid] → [Send to CRM | Send to bounce log]
```

Wire the incoming JSON `email` field to the node with an expression: `{{ $json.email }}`.

### Clean a Google Sheet of B2B leads before an outreach campaign

```
[Google Sheets: Get Rows] → [Giggal.ai: Verify Email (Sequential)] → [Filter: is_valid = true] → [Google Sheets: Append valid rows]
```

Sequential mode is recommended for large sheets so `Continue On Fail` catches individual errors without aborting the whole run. Expect **around 30% more usable addresses** compared to standard verifiers because catch-all and SEG-protected mailboxes get real answers instead of "risky".

### Verify a large list as a batch and fetch results asynchronously

```
[Google Sheets: Get Rows] → [Giggal.ai: Verify Batch] → [Wait 30s] → [Giggal.ai: Job Get Status]
                                                                              ↓
                                                    [If status = completed] → [Giggal.ai: Job Get Results] → [Google Sheets: Append]
                                                                              ↓
                                                                    [Loop back to Wait]
```

For lists of thousands of emails, batch mode is far more efficient than per-item verify. Submit once with **Verify Batch**, poll **Job Get Status** every 30 seconds until `status = "completed"`, then page through **Job Get Results** to write outcomes back to your sheet. Catch-all rescue is enabled by default so SEG-protected and catch-all addresses come back with real valid/invalid verdicts.

### Use inside an AI Agent as a tool

The node is registered with `usableAsTool: true`. In the **AI Agent** node, add **Giggal.ai** as a tool and the agent can autonomously verify email addresses during a conversation. For example, ask *"Is `info@giggal.ai` deliverable?"* and the agent will call the Verify operation and return the result.

---

## Rate limits

- **300 requests per 15 minutes** per API key.
- The node auto-retries on 408 / 429 / 502 / 503 / 504 responses with exponential backoff (up to 3 retries).
- Persistent rate-limit errors surface as `NodeApiError`. If you need a higher tier, contact us via [giggal.ai](https://giggal.ai).

---

## About Giggal.ai

Giggal.ai is a specialised [email verification platform](https://giggal.ai) focused on the hard cases that break standard verifiers:

- Catch-all and accept-all domains
- SEG-protected mailboxes behind Proofpoint, Mimecast, and other gateways
- B2B addresses on custom mail infrastructure
- Freshly-provisioned company domains

Learn more about the catch-all verification methodology and integrations at [giggal.ai](https://giggal.ai). Full API reference is available at [api.giggal.ai](https://api.giggal.ai).

---

## Support

- 📖 [Developer API documentation](https://api.giggal.ai)
- 🔌 [All Giggal.ai integrations](https://giggal.ai/integrations)
- 🐛 [Report a bug](https://github.com/giggal-ai/n8n-nodes-giggal/issues)
- ✉️ [info@giggal.ai](mailto:info@giggal.ai)

---

## Development

```bash
git clone https://github.com/giggal-ai/n8n-nodes-giggal.git
cd n8n-nodes-giggal
npm install
npm run build     # compiles TS to dist/ + copies icons
npm run lint      # ESLint via eslint-plugin-n8n-nodes-base
npm run format    # Prettier
```

To test locally with a self-hosted n8n:

```bash
# In this repo:
npm link

# In your n8n install directory:
npm link n8n-nodes-giggal
```

Restart n8n and the node appears in the picker.

---

## License

[MIT](LICENSE) © 2026 [Giggal.ai](https://giggal.ai)
