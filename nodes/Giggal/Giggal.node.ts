import {
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeConnectionType,
	NodeConnectionTypes,
	NodeOperationError,
} from 'n8n-workflow';

// Public Developer API. Hard-coded intentionally — the base host never
// changes per install; users identify themselves via API key credentials.
const GIGGAL_API_BASE_URL = 'https://api.giggal.ai';

// Which HTTP status codes are safe to auto-retry. 408 = request timeout,
// 429 = rate limit (Giggal returns 300 req / 15 min per key), 502/503/504
// = transient upstream hiccups. Anything else (4xx auth/validation, 5xx
// programming errors) is surfaced immediately with no retry so users see
// real problems fast.
const RETRYABLE_STATUS_CODES = [408, 429, 502, 503, 504];
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;

// Job results endpoint caps limit at 500 server-side. Enforce the same
// bound client-side so mistakes get a clear UI error, not an API 400.
const MAX_RESULTS_LIMIT = 500;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Giggal implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Giggal.ai',
		name: 'giggal',
		icon: 'file:giggal.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description:
			'Verify catch-all, accept-all, and SEG-protected email addresses (Proofpoint, Mimecast) with Giggal.ai. Deep mailbox verification keeps bounce rate under 3% and recovers B2B leads other verifiers flag as risky.',
		defaults: {
			name: 'Giggal.ai',
		},
		inputs: [NodeConnectionTypes.Main] as NodeConnectionType[],
		outputs: [NodeConnectionTypes.Main] as NodeConnectionType[],
		credentials: [
			{
				name: 'giggalApi',
				required: true,
			},
		],
		// Enables the node to be used as an AI Agent tool. The `description`
		// string on each operation is what the AI reads to decide when to
		// call this tool, so keep operation descriptions accurate + intent-y.
		usableAsTool: true,
		properties: [
			// ─── Resource ────────────────────────────────────────────────
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Email',
						value: 'email',
					},
					{
						name: 'Job',
						value: 'job',
					},
					{
						name: 'Account',
						value: 'account',
					},
				],
				default: 'email',
			},

			// ─── Email operations ────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['email'],
					},
				},
				options: [
					{
						name: 'Verify',
						value: 'verify',
						description:
							'Verify a single email address including catch-all, accept-all, and SEG-protected mailboxes (Proofpoint, Mimecast). Returns a clear valid or invalid result, even for addresses other verifiers flag as risky or unknown.',
						action: 'Verify an email address',
					},
					{
						name: 'Verify Batch',
						value: 'verifyBatch',
						description:
							'Submit many email addresses in a single asynchronous batch job. Bundles every input item into one request, returns a job ID immediately, and works for lists of any size. Deep catch-all rescue is enabled by default.',
						action: 'Verify a batch of email addresses',
					},
				],
				default: 'verify',
			},

			// ─── Email: Verify (single) fields ───────────────────────────
			{
				displayName: 'Email Address',
				name: 'email',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'name@example.com',
				description:
					'The email address to verify. Giggal.ai runs a deep mailbox existence check on every address, including catch-all and SEG-protected domains, returning a clear valid or invalid verdict. Costs 1 credit per call.',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['verify'],
					},
				},
			},
			{
				displayName: 'Processing Mode',
				name: 'processingMode',
				type: 'options',
				default: 'sequential',
				description:
					'How to process multiple input items. Sequential is safest and respects Continue On Fail; batch is faster but Giggal.ai rate limits at 300 requests per 15 minutes per API key.',
				options: [
					{
						name: 'Sequential (Recommended)',
						value: 'sequential',
						description: 'Verify emails one at a time. Slower but respects Continue On Fail.',
					},
					{
						name: 'Batch (Concurrent)',
						value: 'batch',
						description: 'Verify all input emails in parallel. Faster but may trip rate limits.',
					},
				],
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['verify'],
					},
				},
			},

			// ─── Email: Verify Batch fields ──────────────────────────────
			{
				displayName: 'Email Field',
				name: 'emailField',
				type: 'string',
				default: 'email',
				required: true,
				description:
					'Name of the field on each input item that holds the email address. Every input item to this node is collected and submitted in a single batch job.',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['verifyBatch'],
					},
				},
			},
			{
				displayName: 'Enable Catch-All Rescue',
				name: 'catchAllRescue',
				type: 'boolean',
				default: true,
				description:
					'Whether to deep-verify catch-all and SEG-protected addresses (Proofpoint, Mimecast). On by default.',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['verifyBatch'],
					},
				},
			},
			{
				displayName: 'Additional Fields',
				name: 'batchAdditionalFields',
				type: 'collection',
				default: {},
				placeholder: 'Add Field',
				displayOptions: {
					show: {
						resource: ['email'],
						operation: ['verifyBatch'],
					},
				},
				options: [
					{
						displayName: 'Batch Name',
						name: 'name',
						type: 'string',
						default: '',
						description: 'Optional friendly name for this batch, visible in the Giggal.ai dashboard',
					},
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description:
							'Unique key to prevent duplicate submissions if the workflow retries. Reusing the same key returns the existing job instead of creating a new one.',
					},
				],
			},

			// ─── Job operations ──────────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['job'],
					},
				},
				options: [
					{
						name: 'Get Status',
						value: 'getStatus',
						description:
							'Get the current status of a batch verification job (queued, processing, completed, failed) along with progress counts',
						action: 'Get status of a batch job',
					},
					{
						name: 'Get Results',
						value: 'getResults',
						description:
							'Get the per-email verification results for a batch job. Returns one output item per email result on the requested page.',
						action: 'Get results of a batch job',
					},
				],
				default: 'getStatus',
			},
			{
				displayName: 'Job ID',
				name: 'jobId',
				type: 'string',
				required: true,
				default: '',
				placeholder: 'api_job_...',
				description: 'The job ID returned by the Verify Batch operation. Usually mapped from a previous node with an expression like {{ $JSON.data.jobId }}.',
				displayOptions: {
					show: {
						resource: ['job'],
					},
				},
			},
			{
				displayName: 'Page',
				name: 'page',
				type: 'number',
				default: 1,
				typeOptions: {
					minValue: 1,
				},
				description: 'Which page of results to fetch',
				displayOptions: {
					show: {
						resource: ['job'],
						operation: ['getResults'],
					},
				},
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				default: 50,
				typeOptions: {
					minValue: 1,
					maxValue: MAX_RESULTS_LIMIT,
				},
				description: 'Max number of results to return',
				displayOptions: {
					show: {
						resource: ['job'],
						operation: ['getResults'],
					},
				},
			},
			{
				displayName: 'Status Filter',
				name: 'statusFilter',
				type: 'string',
				default: '',
				placeholder: 'e.g. deliverable, undeliverable, catch_all',
				description:
					'Optional filter to only return results with a specific status. Leave empty for all results.',
				displayOptions: {
					show: {
						resource: ['job'],
						operation: ['getResults'],
					},
				},
			},

			// ─── Account operations ──────────────────────────────────────
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: {
					show: {
						resource: ['account'],
					},
				},
				options: [
					{
						name: 'Get Credit Balance',
						value: 'getCredits',
						description:
							'Retrieve the current Giggal.ai credit balance so workflows can gate email verification on remaining credits',
						action: 'Get credit balance',
					},
				],
				default: 'getCredits',
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		// Fail fast if credentials are missing — n8n's usual "invalid
		// credentials" error is misleading when the credential itself is
		// unset. This just triggers the standard n8n credential error.
		await this.getCredentials('giggalApi');

		const items = this.getInputData();
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		// Wrap `httpRequestWithAuthentication` with a retry loop that only
		// re-tries the codes in RETRYABLE_STATUS_CODES. Anything else raises
		// immediately as NodeApiError so users see meaningful failures.
		const requestWithRetry = async (
			options: IHttpRequestOptions,
			itemIndex: number,
		): Promise<unknown> => {
			let lastError: unknown;
			for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
				try {
					return await this.helpers.httpRequestWithAuthentication.call(
						this,
						'giggalApi',
						options,
					);
				} catch (error) {
					lastError = error;
					const statusCode =
						(error as { httpCode?: number | string })?.httpCode ??
						(error as { statusCode?: number })?.statusCode;
					const code = Number(statusCode);
					if (RETRYABLE_STATUS_CODES.includes(code) && attempt < MAX_RETRIES) {
						// Exponential backoff: 500ms, 1s, 2s
						await sleep(RETRY_BASE_DELAY_MS * Math.pow(2, attempt));
						continue;
					}
					throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex });
				}
			}
			// Should be unreachable — the loop either returns or throws.
			throw new NodeApiError(this.getNode(), lastError as JsonObject, { itemIndex });
		};

		// ─── Handler: Email:Verify (single, per item) ────────────────
		const handleEmailVerify = async (
			item: INodeExecutionData,
			itemIndex: number,
		): Promise<INodeExecutionData> => {
			const email = (this.getNodeParameter('email', itemIndex, '') as string).trim();
			if (!email) {
				throw new NodeOperationError(this.getNode(), 'Email address is required', {
					itemIndex,
				});
			}
			const options: IHttpRequestOptions = {
				method: 'POST' as IHttpRequestMethods,
				url: `${GIGGAL_API_BASE_URL}/v1/verify`,
				body: { email },
				json: true,
			};
			const response = await requestWithRetry(options, itemIndex);
			return {
				json: response as JsonObject,
				pairedItem: { item: itemIndex },
			};
		};

		// ─── Handler: Account:GetCredits (single call) ───────────────
		const handleGetCredits = async (): Promise<INodeExecutionData> => {
			const options: IHttpRequestOptions = {
				method: 'GET' as IHttpRequestMethods,
				url: `${GIGGAL_API_BASE_URL}/v1/credits`,
				json: true,
			};
			const response = await requestWithRetry(options, 0);
			return {
				json: response as JsonObject,
				pairedItem: { item: 0 },
			};
		};

		// ─── Handler: Job:GetStatus (per item, jobId from item) ──────
		const handleJobGetStatus = async (
			itemIndex: number,
		): Promise<INodeExecutionData> => {
			const jobId = (this.getNodeParameter('jobId', itemIndex, '') as string).trim();
			if (!jobId) {
				throw new NodeOperationError(this.getNode(), 'Job ID is required', { itemIndex });
			}
			const options: IHttpRequestOptions = {
				method: 'GET' as IHttpRequestMethods,
				url: `${GIGGAL_API_BASE_URL}/v1/jobs/${encodeURIComponent(jobId)}`,
				json: true,
			};
			const response = await requestWithRetry(options, itemIndex);
			return {
				json: response as JsonObject,
				pairedItem: { item: itemIndex },
			};
		};

		// ─── Handler: Job:GetResults (per item, expands page into N items) ───
		const handleJobGetResults = async (
			itemIndex: number,
		): Promise<INodeExecutionData[]> => {
			const jobId = (this.getNodeParameter('jobId', itemIndex, '') as string).trim();
			if (!jobId) {
				throw new NodeOperationError(this.getNode(), 'Job ID is required', { itemIndex });
			}
			const page = this.getNodeParameter('page', itemIndex, 1) as number;
			const limit = this.getNodeParameter('limit', itemIndex, 50) as number;
			const statusFilter = (this.getNodeParameter('statusFilter', itemIndex, '') as string).trim();

			const qs: Record<string, string | number> = { page, limit };
			if (statusFilter) qs.status = statusFilter;

			const options: IHttpRequestOptions = {
				method: 'GET' as IHttpRequestMethods,
				url: `${GIGGAL_API_BASE_URL}/v1/jobs/${encodeURIComponent(jobId)}/results`,
				qs,
				json: true,
			};

			const response = (await requestWithRetry(options, itemIndex)) as {
				success?: boolean;
				status?: string;
				data?: { job?: JsonObject; results?: JsonObject[]; pagination?: JsonObject };
			};

			const results = response.data?.results ?? [];
			const jobMeta = response.data?.job;
			const pagination = response.data?.pagination;

			// One output item per email result. Attach job + pagination
			// metadata under `_giggal` so downstream nodes can Filter/Route
			// on either the result fields or the wrapper metadata without
			// polluting the top-level result shape.
			if (results.length === 0) {
				return [
					{
						json: {
							_giggal: {
								job: jobMeta,
								pagination,
								status: response.status,
							},
							message: response.status === 'processing'
								? 'Validation in progress — retry after a short delay.'
								: 'No results on this page.',
						},
						pairedItem: { item: itemIndex },
					},
				];
			}

			return results.map((result) => ({
				json: {
					...(result as JsonObject),
					_giggal: { job: jobMeta, pagination },
				},
				pairedItem: { item: itemIndex },
			}));
		};

		// ─── Special case: Email:VerifyBatch (single call, all items) ───
		// Bundles every input item into ONE API call and returns one output
		// item with the jobId + submission stats. This is the whole point of
		// batch verification — piping N emails as a single job.
		if (resource === 'email' && operation === 'verifyBatch') {
			const emailField = (this.getNodeParameter('emailField', 0, 'email') as string).trim();
			if (!emailField) {
				throw new NodeOperationError(this.getNode(), 'Email Field is required', {
					itemIndex: 0,
				});
			}
			const catchAllRescue = this.getNodeParameter('catchAllRescue', 0, true) as boolean;
			const additional = this.getNodeParameter('batchAdditionalFields', 0, {}) as {
				name?: string;
				idempotencyKey?: string;
			};

			// Collect emails from every input item using the user's specified
			// field name. Coerce to string, trim, drop empties. Duplicates
			// are handled server-side by normalizeBatchEmails.
			const emails: string[] = [];
			for (let i = 0; i < items.length; i++) {
				const raw = items[i]?.json?.[emailField];
				if (raw === undefined || raw === null) continue;
				const email = String(raw).trim();
				if (email) emails.push(email);
			}

			if (emails.length === 0) {
				throw new NodeOperationError(
					this.getNode(),
					`No emails found. Every input item is missing the "${emailField}" field, or the field values are empty.`,
					{ itemIndex: 0 },
				);
			}

			const body: JsonObject = {
				emails,
				validationFlags: { auto_catchall_rescue: catchAllRescue },
			};
			if (additional.name?.trim()) body.name = additional.name.trim();

			const headers: Record<string, string> = {};
			if (additional.idempotencyKey?.trim()) {
				headers['Idempotency-Key'] = additional.idempotencyKey.trim();
			}

			const options: IHttpRequestOptions = {
				method: 'POST' as IHttpRequestMethods,
				url: `${GIGGAL_API_BASE_URL}/v1/verify-batch`,
				body,
				headers: Object.keys(headers).length ? headers : undefined,
				json: true,
			};

			try {
				const response = await requestWithRetry(options, 0);
				return [
					[
						{
							json: response as JsonObject,
							pairedItem: items.map((_, i) => ({ item: i })),
						},
					],
				];
			} catch (error) {
				if (this.continueOnFail()) {
					return [
						[
							{
								json: { error: (error as Error).message },
								pairedItem: items.map((_, i) => ({ item: i })),
							},
						],
					];
				}
				throw error;
			}
		}

		// ─── Special case: Account:GetCredits (single call regardless of items) ─
		if (resource === 'account' && operation === 'getCredits') {
			try {
				const result = await handleGetCredits();
				return [[result]];
			} catch (error) {
				if (this.continueOnFail()) {
					return [
						[
							{
								json: { error: (error as Error).message },
								pairedItem: { item: 0 },
							},
						],
					];
				}
				throw error;
			}
		}

		// ─── Per-item flow: Email:Verify + Job:GetStatus + Job:GetResults ───
		// Job:GetResults returns MANY items per input item (paginated
		// results expanded into individual n8n items), so we flatten.
		const processingMode =
			resource === 'email' && operation === 'verify'
				? (this.getNodeParameter('processingMode', 0, 'sequential') as string)
				: 'sequential';

		const processItem = async (
			item: INodeExecutionData,
			itemIndex: number,
		): Promise<INodeExecutionData[]> => {
			if (resource === 'email' && operation === 'verify') {
				return [await handleEmailVerify(item, itemIndex)];
			}
			if (resource === 'job' && operation === 'getStatus') {
				return [await handleJobGetStatus(itemIndex)];
			}
			if (resource === 'job' && operation === 'getResults') {
				return handleJobGetResults(itemIndex);
			}
			throw new NodeOperationError(
				this.getNode(),
				`Unsupported operation: ${resource}.${operation}`,
				{ itemIndex },
			);
		};

		// Concurrent — used only by Email:Verify Batch (Concurrent) mode.
		if (processingMode === 'batch') {
			const settled = await Promise.allSettled(
				items.map((item, itemIndex) => processItem(item, itemIndex)),
			);
			const returnItems: INodeExecutionData[] = [];
			settled.forEach((result, itemIndex) => {
				if (result.status === 'fulfilled') {
					returnItems.push(...result.value);
				} else {
					returnItems.push({
						json: { error: (result.reason as Error).message },
						pairedItem: { item: itemIndex },
					});
				}
			});
			return [returnItems];
		}

		// Sequential — canonical n8n pattern with continueOnFail support.
		const returnData: INodeExecutionData[] = [];
		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			try {
				returnData.push(...(await processItem(items[itemIndex], itemIndex)));
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: itemIndex },
					});
					continue;
				}
				if (error instanceof NodeApiError || error instanceof NodeOperationError) {
					throw error;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex });
			}
		}
		return [returnData];
	}
}
