import {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Giggal.ai Developer API credentials.
 *
 * Giggal.ai is a catch-all email verifier that returns clear valid or
 * invalid results for catch-all, accept-all, and SEG-protected addresses
 * (Proofpoint, Mimecast) that standard verifiers flag as risky or unknown.
 * See https://giggal.ai for details.
 *
 * Users obtain an API key from https://emailverifier.giggal.ai/developer-api
 * and paste it here. n8n stores the key encrypted and injects it into every
 * outgoing request as `Authorization: Bearer <key>`.
 *
 * On save, n8n calls the `test` endpoint below to validate the key. A 200
 * confirms the key works, anything else (401 / 403) surfaces as a red error
 * in the credentials UI so users see problems immediately, not later at
 * workflow-run time.
 */
export class GiggalApi implements ICredentialType {
	name = 'giggalApi';
	displayName = 'Giggal.ai API';
	documentationUrl = 'https://giggal.ai/integrations/n8n';
	icon: Icon = { light: 'file:giggal.svg', dark: 'file:giggal.dark.svg' };
	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
			description:
				'Your Giggal.ai Developer API key. Create one in the Developer API tab at https://emailverifier.giggal.ai/developer-api. Learn more about Giggal.ai catch-all email verification at https://giggal.ai.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: 'https://api.giggal.ai',
			url: '/v1/credits',
			method: 'GET',
		},
	};
}
