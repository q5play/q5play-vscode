const vscode = require('vscode'),
	Uri = vscode.Uri,
	vsfs = vscode.workspace.fs,
	os = require('os'),
	fs = require('fs'),
	path = require('path'),
	http = require('http'),
	https = require('https'),
	crypto = require('crypto'),
	asn1 = require('@panva/asn1.js');

let port = 5555;

const mimeTypes = {
	// Text / markup
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.xhtml': 'application/xhtml+xml',
	'.xml': 'application/xml; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
	// Scripts
	'.js': 'application/javascript; charset=utf-8',
	'.mjs': 'application/javascript; charset=utf-8',
	'.cjs': 'application/javascript; charset=utf-8',
	'.ts': 'application/typescript; charset=utf-8',
	'.jsx': 'application/javascript; charset=utf-8',
	'.tsx': 'application/javascript; charset=utf-8',
	// Styles
	'.css': 'text/css; charset=utf-8',
	// Data
	'.json': 'application/json; charset=utf-8',
	'.jsonc': 'application/json; charset=utf-8',
	'.jsonld': 'application/ld+json',
	'.yaml': 'text/yaml; charset=utf-8',
	'.yml': 'text/yaml; charset=utf-8',
	'.toml': 'application/toml; charset=utf-8',
	'.map': 'application/json',
	'.webmanifest': 'application/manifest+json',
	// WebAssembly
	'.wasm': 'application/wasm',
	// Images
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.svg': 'image/svg+xml',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.bmp': 'image/bmp',
	'.tiff': 'image/tiff',
	'.tif': 'image/tiff',
	// Fonts
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	// Audio
	'.mp3': 'audio/mpeg',
	'.ogg': 'audio/ogg',
	'.oga': 'audio/ogg',
	'.wav': 'audio/wav',
	'.flac': 'audio/flac',
	'.aac': 'audio/aac',
	'.m4a': 'audio/mp4',
	'.opus': 'audio/opus',
	'.mid': 'audio/midi',
	'.midi': 'audio/midi',
	// Video
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.ogv': 'video/ogg',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
	'.m4v': 'video/mp4',
	// Misc
	'.pdf': 'application/pdf'
};

const LIVERELOAD_SCRIPT = `<script>(function(){var es=new EventSource('/livereload-events');es.onmessage=function(){location.reload();};es.onerror=function(){es.close();setTimeout(function(){location.reload();},2000);};})();</script>`;

let sseClients = [];

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
let httpServer;
let httpsServer;
let httpsPort;
let fileWatcher;

/**
 * Generates a self-signed X.509 cert using Node.js built-ins and @panva/asn1.js.
 * This provides a robust, spec-compliant encoder with zero transitive dependencies.
 */
function generateSelfSignedCert(ip) {
	// Generate EC P-256 key pair
	const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
		namedCurve: 'prime256v1'
	});

	// SubjectPublicKeyInfo DER — already correctly encoded by Node.js crypto
	const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

	// --- ASN.1 structure definitions ---

	const AlgorithmIdentifier = asn1.define('AlgorithmIdentifier', function () {
		this.seq().obj(this.key('algorithm').objid(), this.key('parameters').optional().any());
	});

	const ATAV = asn1.define('ATAV', function () {
		this.seq().obj(this.key('type').objid(), this.key('value').any());
	});

	const RDN = asn1.define('RDN', function () {
		this.setof(ATAV);
	});

	const Name = asn1.define('Name', function () {
		this.seqof(RDN);
	});

	const Validity = asn1.define('Validity', function () {
		this.seq().obj(this.key('notBefore').utctime(), this.key('notAfter').utctime());
	});

	const Extension = asn1.define('Extension', function () {
		this.seq().obj(this.key('extnID').objid(), this.key('critical').bool().def(false), this.key('extnValue').octstr());
	});

	const Extensions = asn1.define('Extensions', function () {
		this.seqof(Extension);
	});

	// subjectPublicKeyInfo and tbsCertificate are passed as raw DER via .any()
	// to avoid re-encoding and guarantee byte-for-byte identity when signing.
	const TBSCertificate = asn1.define('TBSCertificate', function () {
		this.seq().obj(
			this.key('version').explicit(0).int(),
			this.key('serialNumber').int(),
			this.key('signature').use(AlgorithmIdentifier),
			this.key('issuer').use(Name),
			this.key('validity').use(Validity),
			this.key('subject').use(Name),
			this.key('subjectPublicKeyInfo').any(),
			this.key('extensions').explicit(3).use(Extensions)
		);
	});

	const Certificate = asn1.define('Certificate', function () {
		this.seq().obj(
			this.key('tbsCertificate').any(), // pass pre-encoded DER directly
			this.key('signatureAlgorithm').use(AlgorithmIdentifier),
			this.key('signatureValue').bitstr()
		);
	});

	// OIDs
	const OID_ECDSA_SHA256 = [1, 2, 840, 10045, 4, 3, 2];
	const OID_COMMON_NAME = [2, 5, 4, 3];
	const OID_SAN = [2, 5, 29, 17];

	// CN value encoded as UTF8String (tag 0x0C)
	const cnBytes = Buffer.from('q5play', 'utf8');
	const cnValue = Buffer.concat([Buffer.from([0x0c, cnBytes.length]), cnBytes]);

	// SAN extension value: GeneralNames { iPAddress [7] IMPLICIT <4 octets> }
	const ipOctets = Buffer.from(ip.split('.').map(Number));
	const iPAddressTagged = Buffer.concat([Buffer.from([0x87, ipOctets.length]), ipOctets]);
	const sanValue = Buffer.concat([Buffer.from([0x30, iPAddressTagged.length]), iPAddressTagged]);

	// Validity window: now → now + 1 year
	const now = new Date();
	const notAfter = new Date(now);
	notAfter.setFullYear(notAfter.getFullYear() + 1);

	// Random 128-bit serial number (always positive BigInt)
	const serialNumber = BigInt('0x' + crypto.randomBytes(16).toString('hex'));

	const algId = { algorithm: OID_ECDSA_SHA256 };
	const name = [[{ type: OID_COMMON_NAME, value: cnValue }]];

	// Encode TBSCertificate
	const tbsDer = TBSCertificate.encode(
		{
			version: 2n, // v3
			serialNumber,
			signature: algId,
			issuer: name,
			validity: { notBefore: now.getTime(), notAfter: notAfter.getTime() },
			subject: name,
			subjectPublicKeyInfo: spkiDer,
			extensions: [{ extnID: OID_SAN, critical: false, extnValue: sanValue }]
		},
		'der'
	);

	// Sign the TBSCertificate bytes
	const sig = crypto.sign('SHA256', tbsDer, privateKey);

	// Encode the outer Certificate structure
	const certDer = Certificate.encode(
		{
			tbsCertificate: tbsDer,
			signatureAlgorithm: algId,
			signatureValue: { data: sig, unused: 0 }
		},
		'der'
	);

	// PEM output
	const certPem =
		'-----BEGIN CERTIFICATE-----\n' +
		certDer
			.toString('base64')
			.match(/.{1,64}/g)
			.join('\n') +
		'\n-----END CERTIFICATE-----';
	const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

	return { cert: certPem, key: keyPem };
}

/**
 * Starts an HTTPS reverse-proxy in front of the HTTP server. Mobile browsers
 * need HTTPS to get a secure context (required for WebGPU / navigator.gpu).
 */
async function startHttpsProxy(httpPort, localIP) {
	if (localIP === '0.0.0.0') return;

	const credentials = generateSelfSignedCert(localIP);

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

function injectLiveReload(data) {
	const html = data.toString('utf8');
	const i = html.lastIndexOf('</body>');
	if (i !== -1) return html.slice(0, i) + LIVERELOAD_SCRIPT + html.slice(i);
	return html + LIVERELOAD_SCRIPT;
}

async function startServer() {
	if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) return;

	const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
	const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : workspaceRoot + path.sep;

	httpServer = http.createServer((req, res) => {
		// SSE endpoint for live reload
		if (req.url === '/livereload-events') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
				'Access-Control-Allow-Origin': '*'
			});
			res.write('retry: 2000\n\n');
			sseClients.push(res);
			req.on('close', () => {
				sseClients = sseClients.filter((c) => c !== res);
			});
			return;
		}

		// Strip query string and decode URL
		let urlPath = req.url.split('?')[0];
		try {
			urlPath = decodeURIComponent(urlPath);
		} catch {}
		if (urlPath === '/') urlPath = '/index.html';

		// Security: prevent path traversal
		const filePath = path.join(workspaceRoot, urlPath);
		if (!filePath.startsWith(rootWithSep) && filePath !== workspaceRoot) {
			res.writeHead(403);
			res.end('Forbidden');
			return;
		}

		const ext = path.extname(filePath).toLowerCase();
		fs.readFile(filePath, (err, data) => {
			if (err) {
				if (err.code === 'ENOENT' || err.code === 'EISDIR') {
					// SPA fallback: serve index.html
					fs.readFile(path.join(workspaceRoot, 'index.html'), (err2, fallback) => {
						if (err2) {
							res.writeHead(404);
							res.end('Not Found');
							return;
						}
						res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
						res.end(injectLiveReload(fallback));
					});
				} else {
					res.writeHead(500);
					res.end('Server Error');
				}
				return;
			}
			const contentType = mimeTypes[ext] || 'application/octet-stream';
			res.writeHead(200, { 'Content-Type': contentType });
			res.end(ext === '.html' ? injectLiveReload(data) : data);
		});
	});

	const maxAttempts = 10;
	let attempts = 0;
	while (attempts < maxAttempts) {
		try {
			await new Promise((resolve, reject) => {
				httpServer.listen(port, '127.0.0.1', resolve);
				httpServer.once('error', reject);
			});
			break;
		} catch {
			attempts++;
			port++;
		}
	}

	if (attempts >= maxAttempts) {
		vscode.window.showErrorMessage('Failed to start server on any port.');
		return;
	}

	serverStarted = true;
	await startHttpsProxy(port, getLocalNetworkIPAddress());

	// Watch workspace files and notify SSE clients to trigger live reload
	fileWatcher = vscode.workspace.createFileSystemWatcher(
		new vscode.RelativePattern(vscode.workspace.workspaceFolders[0], '**/*')
	);
	const notifyReload = () => {
		for (const client of sseClients) {
			try {
				client.write('data: reload\n\n');
			} catch {}
		}
	};
	fileWatcher.onDidChange(notifyReload);
	fileWatcher.onDidCreate(notifyReload);
	fileWatcher.onDidDelete(notifyReload);
}

async function openTab() {
	if (!serverStarted) await startServer();

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
	if (fileWatcher) fileWatcher.dispose();
	if (httpServer) httpServer.close();
	if (httpsServer) httpsServer.close();
}

module.exports = {
	activate,
	deactivate
};
