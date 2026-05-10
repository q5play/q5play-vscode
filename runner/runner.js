/**
 * q5play-vscode/runner/runner.js
 * Runs in the VSCode webview
 * @author quinton-ashley
 */

const log = console.log;

let vscode;
if (typeof acquireVsCodeApi == 'function') vscode = acquireVsCodeApi();

/* NEW PROJECT */

document.getElementById('newQ5ProjectBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'newProject', type: 'q5play' });
});

document.getElementById('newP5ProjectBtn').addEventListener('click', () => {
	vscode.postMessage({ command: 'newProject', type: 'p5play' });
});

/* NAV */

let activeZone = document.getElementById('sceneZone');
let zones = document.getElementsByClassName('zone');

function activateZone(zone) {
	activeZone?.classList.remove('active');
	activeZone = document.getElementById(zone);
	activeZone.classList.add('active');
}

playBtn.addEventListener('click', () => {
	console.clear();
	activateZone('sceneZone');
	document.getElementById('sceneZone').src += '';
});

debugBtn.addEventListener('click', () => {
	vscode.postMessage({ command: 'openDevTools' });
});

mobileZoneBtn.addEventListener('click', () => {
	activateZone('mobileZone');
	genMobileQRCode();
});

browserBtn.addEventListener('click', () => {
	vscode.postMessage({ command: 'openInBrowser' });
});

// Make topNav draggable

const topNav = document.getElementById('topNav');
{
	let isDragging = false;
	let startX, startY, initialX, initialY;

	topNav.addEventListener('mousedown', (e) => {
		isDragging = true;
		startX = e.clientX;
		startY = e.clientY;
		initialX = topNav.offsetLeft;
		initialY = topNav.offsetTop;
		document.addEventListener('mousemove', onMouseMove);
		document.addEventListener('mouseup', onMouseUp);
	});

	function onMouseMove(e) {
		if (isDragging) {
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			topNav.style.left = `${initialX + dx}px`;
			topNav.style.top = `${initialY + dy}px`;
		}
	}

	function onMouseUp() {
		isDragging = false;
		document.removeEventListener('mousemove', onMouseMove);
		document.removeEventListener('mouseup', onMouseUp);
	}
}

window.addEventListener('message', (event) => {
	const message = event.data;

	switch (message.command) {
		case 'workspaceIsEmpty':
			console.log('Workspace is empty.');
			topNav.style.display = 'none';
			activateZone('newProjectZone');
			break;
		case 'workspaceHasFolder':
			console.log('Workspace has a folder:');
			topNav.style.display = 'flex';
			activateZone('sceneZone');
			break;
	}
});

/* MOBILE */

async function genMobileQRCode() {
	let qr0 = document.getElementById('qr0');
	if (qr0) return;

	let qrDiv = document.getElementById('qr');

	qr0 = document.createElement('qr-code');
	qr0.id = 'qr0';
	qr0.innerHTML = qrDiv.innerHTML;
	qr0.contents = 'https://' + window?.ipAddress + ':' + window?.httpsPort;
	qr0.moduleColor = 'var(--pink)';
	qr0.positionRingColor = 'var(--pink)';
	qr0.positionCenterColor = 'var(--blue)';
	qr0.maskXToYRatio = '1';
	qr0.addEventListener('codeRendered', () => {
		qr0.animateQRCode((targets, _x, _y, _count, entity) => ({
			targets,
			from: entity === 'module' ? Math.random() * 200 : 200,
			duration: 500,
			easing: 'cubic-bezier(1,1,0,.5)',
			web: {
				opacity: [0, 1],
				scale: [0.3, 1.13, 0.93, 1]
			}
		}));
	});

	qrDiv.innerHTML = '';
	qrDiv.append(qr0);

	let url = document.createElement('span');
	url.innerHTML = qr0.contents;

	qrDiv.append(url);

	// Show TLS / self-signed certificate note for mobile users
	let tlsNote = document.createElement('div');
	tlsNote.id = 'tlsNote';
	tlsNote.textContent =
		'Note: q5.js WebGPU requires a secure (HTTPS) context. To enable local development this extension uses a self-signed certificate. Your mobile device may display security warnings but you can safely proceed to run the sketch.';
	qrDiv.append(tlsNote);
}
