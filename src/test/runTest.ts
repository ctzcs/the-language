import * as path from 'path';
import * as fs from 'fs';

import { runTests } from 'vscode-test';

async function main() {
	try {
		// The folder containing the Extension Manifest package.json
		// Passed to `--extensionDevelopmentPath`
		const extensionDevelopmentPath = path.resolve(__dirname, '../../');

		// The path to test runner
		// Passed to --extensionTestsPath
		const extensionTestsPath = path.resolve(__dirname, './suite/index');
		const testWorkspace = path.join(extensionDevelopmentPath, '.vscode-test', 'workspace');
		fs.mkdirSync(testWorkspace, { recursive: true });

		// Download VS Code, unzip it and run the integration test
		await runTests({ extensionDevelopmentPath, extensionTestsPath,
			vscodeExecutablePath: process.env.VSCODE_TEST_EXECUTABLE,
			launchArgs: [testWorkspace, '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes',
				'--user-data-dir=' + path.join(extensionDevelopmentPath, '.vscode-test', 'user-data-' + process.pid),
				'--extensions-dir=' + path.join(extensionDevelopmentPath, '.vscode-test', 'extensions')] });
	} catch (err) {
		console.error('Failed to run tests');
		process.exit(1);
	}
}

main();
