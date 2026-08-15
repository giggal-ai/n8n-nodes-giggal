/**
 * Stricter ruleset applied only in the `prepublishOnly` script.
 * Ensures the published npm build meets n8n's community-node scanner
 * requirements — no relaxed rules from the regular dev config.
 */
module.exports = {
	extends: './.eslintrc.js',
	overrides: [
		{
			files: ['package.json'],
			plugins: ['eslint-plugin-n8n-nodes-base'],
			rules: {
				'n8n-nodes-base/community-package-json-name-still-default': 'error',
			},
		},
	],
};
