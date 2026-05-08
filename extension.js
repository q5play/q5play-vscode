const vscode = require('vscode'),
	Uri = vscode.Uri,
	vsfs = vscode.workspace.fs,
	os = require('os'),
	http = require('http'),
	https = require('https'),
	net = require('net'),
	selfsigned = require('selfsigned'),
	liveServer = require('live-server');

let port = 5555;

const log = console.log;

let panel;

function getLocalNetworkIPAddress() {
	const interfaces = os.networkInterfaces();

	// Skip VPNs, tunnels, and virtual/VM interfaces — mobile devices can't reach these
	const skipPrefixes = ['utun', 'tun', 'tap', 'vmnet', 'vboxnet', 'docker', 'br-', 'veth', 'lo'];

	// 192.168.x.x is almost exclusively local Wi-Fi/LAN.
	// 10.x.x.x and 172.16-31.x.x are also valid LAN ranges.
	function lanPriority(addr) {
		if (addr.startsWith('192.168.')) return 0;
		if (addr.startsWith('10.')) return 1;
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 2;
		return 3; // non-private, ignore
	}

	// Prefer known physical interface name prefixes
	const physicalPrefixes = ['en', 'eth', 'Wi-Fi'];

	let best = null; // { address, priority }

	for (const [name, addrs] of Object.entries(interfaces)) {
		if (skipPrefixes.some((p) => name.toLowerCase().startsWith(p))) continue;
		const isPhysical = physicalPrefixes.some((p) => name.startsWith(p));

		for (const iface of addrs) {
			if (iface.family !== 'IPv4' || iface.internal) continue;
			const priority = lanPriority(iface.address);
			if (priority === 3) continue; // not a private address

			// Prefer physical interfaces; within that, prefer lower priority number (better range)
			const score = (isPhysical ? 0 : 10) + priority;
			if (!best || score < best.score) {
				best = { address: iface.address, score };
			}
		}
	}

	return best?.address || '0.0.0.0';
}

async function newProject(type = 'q5play') {
	try {
		const label = type === 'p5play' ? 'p5play (legacy)' : 'q5play';
		// Prompt the user for a new folder name
		const folderName = await vscode.window.showInputBox({
			prompt: `Enter a name for the new ${label} project folder`,
			validateInput: (text) => (text.trim() === '' ? 'Folder name cannot be empty' : null)
		});
		if (!folderName) return;

		// Prompt the user to select a folder
		let filePath = await vscode.window.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: false,
			message: 'Select a destination folder for the new project'
		});
		if (!filePath) return;

		const dest = Uri.joinPath(Uri.file(filePath[0].path), folderName);
		await vscode.workspace.fs.createDirectory(dest);

		const src = Uri.joinPath(Uri.file(__dirname), type === 'p5play' ? 'p5play-template' : 'q5play-template');

		const success = await copyDirectory(src, dest);
		if (!success) {
			vscode.window.showErrorMessage('Error copying directory.');
		}

		// Open the new project folder in a new window
		await vscode.commands.executeCommand('vscode.openFolder', dest, true);

		// Hacky way to actually open the sketch file...
		if (process.platform !== 'win32') {
			let sketchFile = Uri.joinPath(dest, 'sketch.js').path;
			sketchFile = Uri.parse('vscode://file' + sketchFile);
			await vscode.env.openExternal(sketchFile);
		}
	} catch (e) {
		console.error(e);
		vscode.window.showErrorMessage(e.message);
	}
}

async function copyDirectory(srcDir, destDir) {
	try {
		const entries = await vsfs.readDirectory(srcDir);

		for (const [entryName, entryType] of entries) {
			const src = Uri.joinPath(srcDir, entryName);
			const dest = Uri.joinPath(destDir, entryName);

			if (entryType === vscode.FileType.File) {
				// Copy a file
				const sourceFileData = await vsfs.readFile(src);
				await vsfs.writeFile(dest, sourceFileData);
			} else if (entryType === vscode.FileType.Directory) {
				// Recursively copy a directory
				await copyDirectory(src, dest);
			}
		}

		return true;
	} catch (error) {
		return false;
	}
}

let serverStarted = false;
let httpsServer;
let httpsPort;

/**
 * Generates a self-signed cert with the local IP as a SAN and starts an
 * HTTPS reverse-proxy in front of the HTTP live-server.  Mobile browsers
 * need HTTPS to get a secure context (required for WebGPU / navigator.gpu).
 */
async function startHttpsProxy(httpPort, localIP) {
	if (localIP === '0.0.0.0') return;

	const pems = await selfsigned.generate([{ name: 'commonName', value: localIP }], {
		keySize: 2048,
		days: 825, // max iOS accepts without an extra trust step
		algorithm: 'sha256',
		extensions: [
			{
				name: 'subjectAltName',
				altNames: [
					{ type: 7, ip: localIP }, // IP SAN — required for Chrome/Safari
					{ type: 2, value: 'localhost' } // DNS SAN
				]
			}
		]
	});

	const credentials = { key: pems.private, cert: pems.cert };

	// Forward regular HTTP requests to live-server
	httpsServer = https.createServer(credentials, (req, res) => {
		const options = {
			hostname: '127.0.0.1',
			port: httpPort,
			path: req.url,
			method: req.method,
			headers: { ...req.headers, host: `127.0.0.1:${httpPort}` }
		};
		const proxyReq = http.request(options, (proxyRes) => {
			res.writeHead(proxyRes.statusCode, proxyRes.headers);
			proxyRes.pipe(res);
		});
		proxyReq.on('error', () => res.end());
		req.pipe(proxyReq);
	});

	// Forward WebSocket upgrades (live-server's live-reload)
	httpsServer.on('upgrade', (req, socket, head) => {
		const conn = net.connect(httpPort, '127.0.0.1', () => {
			const headerLines = Object.entries(req.headers)
				.map(([k, v]) => `${k}: ${v}`)
				.join('\r\n');
			conn.write(`GET ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
			if (head.length) conn.write(head);
			conn.pipe(socket);
			socket.pipe(conn);
		});
		conn.on('error', () => socket.destroy());
		socket.on('error', () => conn.destroy());
	});

	const maxTries = 10;
	let proxyPort = httpPort + 1;
	for (let i = 0; i < maxTries; i++, proxyPort++) {
		try {
			await new Promise((resolve, reject) => {
				httpsServer.listen(proxyPort, '0.0.0.0', resolve);
				httpsServer.once('error', reject);
			});
			httpsPort = proxyPort;
			return;
		} catch {
			continue;
		}
	}
}

async function startLiveServer() {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
		return;
	}

	const workspaceFolder = vscode.workspace.workspaceFolders[0].uri.fsPath;

	const maxAttempts = 10; // Maximum number of ports to try
	let attempts = 0;

	function tryStartServer(port) {
		return new Promise((resolve, reject) => {
			const params = {
				host: '127.0.0.1', // HTTPS proxy handles external connections
				port,
				root: workspaceFolder,
				open: false, // don't open in the browser
				ignore: 'node_modules',
				file: 'index.html',
				wait: 0 // wait time before reloading
			};

			liveServer
				.start(params)
				.on('listening', () => {
					resolve(port);
				})
				.on('error', (err) => {
					reject(err);
				});
		});
	}

	while (attempts < maxAttempts) {
		try {
			await tryStartServer(port);
			break;
		} catch (err) {
			attempts++;
			port++;
		}
	}

	if (attempts >= maxAttempts) {
		vscode.window.showErrorMessage('Failed to start live server on any port.');
		return;
	}

	await startHttpsProxy(port, getLocalNetworkIPAddress());
}

async function openTab() {
	if (!serverStarted) await startLiveServer();

	panel = vscode.window.createWebviewPanel('q5play', 'q5play', vscode.ViewColumn.Two, {
		enableScripts: true,
		localResourceRoots: [vscode.Uri.file(__dirname)]
	});
	// Set the webview tab icon (uses the extension's icon)
	try {
		panel.iconPath = Uri.file(__dirname + '/assets/q5play_logo.svg');
	} catch (e) {
		// Some older VS Code API versions may not support `iconPath` — ignore failures
	}

	const htmlPath = Uri.file(__dirname + '/runner/index.html');
	let html = await vsfs.readFile(htmlPath);
	html = Buffer.from(html).toString('utf8');

	// get sandboxed file path
	function getSource(file) {
		const path = Uri.file(__dirname + '/runner/' + file);
		return panel.webview.asWebviewUri(path);
	}
	function importHTML(file, fileToReplace) {
		html = html.replaceAll(fileToReplace || file, getSource(file));
	}

	html = html.replace('<link rel="stylesheet" href="icons.css">', '');

	importHTML('runner.css');
	importHTML('runner.js');
	importHTML('../node_modules/@bitjson/qr-code/dist/qr-code.js');
	importHTML('../assets/q5play_icon.png');
	importHTML('../assets/q5play_logo.svg');

	const cssPath = Uri.file(__dirname + '/runner/icons.css');
	let style = await vsfs.readFile(cssPath);
	style = Buffer.from(style).toString('utf8');
	function importStyle(file, fileToReplace) {
		style = style.replace(fileToReplace || file, getSource(file));
	}

	let svgFiles = [
		// 'android',
		// 'app-store-ios',
		// 'apple',
		// 'book-open',
		'bug-report',
		'create-new-folder',
		'display',
		// 'folder-open',
		// 'google-play',
		// 'hammer',
		// 'language',
		'mobile-screen-button',
		'play',
		// 'share-from-square',
		// 'stop'
		'refresh'
	];

	for (const file of svgFiles) {
		importStyle('icons/' + file + '.svg');
	}

	// Fix the hardcoded port in the iframe src
	html = html.replace('http://127.0.0.1:5555/', `http://127.0.0.1:${port}/`);

	let globals = `
<script>
window.ipAddress = '${getLocalNetworkIPAddress()}';
window.port = ${port};
window.httpsPort = ${httpsPort ?? 'undefined'};
</script>`;

	const startOfHead = html.indexOf('<head>') + 6;
	html = html.slice(0, startOfHead) + '<style>' + style + '</style>' + globals + html.slice(startOfHead);

	panel.webview.html = html;

	// Listen for messages from the webview
	panel.webview.onDidReceiveMessage(async (message) => {
		switch (message.command) {
			case 'newProject':
				await newProject(message.type);
				break;
			case 'openInBrowser':
				// open the live server link in the default browser
				const url = 'http://127.0.0.1:' + port;
				await vscode.env.openExternal(vscode.Uri.parse(url));
				break;
			case 'openDevTools':
				vscode.commands.executeCommand('workbench.action.toggleDevTools');
				break;
		}
	});

	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length == 0) {
		panel.webview.postMessage({ command: 'workspaceIsEmpty' });
	}
}

function activate(context) {
	let cmd = vscode.commands.registerCommand('q5play-vscode.newProject', newProject);
	context.subscriptions.push(cmd);

	cmd = vscode.commands.registerCommand('q5play-vscode.openRunner', openTab);
	context.subscriptions.push(cmd);

	// for testing, remove this line to disable auto-open
	// vscode.commands.executeCommand('q5play-vscode.openRunner');

	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 0);
	statusBar.text = '$(game) q5play';
	statusBar.tooltip = 'Click to open the q5play runner.';
	statusBar.command = 'q5play-vscode.openRunner';
	statusBar.show();

	context.subscriptions.push(statusBar);
}

function deactivate() {
	if (panel) panel.dispose();
	if (serverStarted) liveServer.shutdown();
	if (httpsServer) httpsServer.close();
}

module.exports = {
	activate,
	deactivate
};
