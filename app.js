let Sugar = require('sugar');
require('sugar-inflections');
Sugar.extend();
process.env.TERM = process.env.TERM || 'linux';

console.log('Starting...');

let app = {
	argv : require('optimist').argv,
	fs   : require('mz/fs'),
	stdin: process.stdin,
	term : require('terminal-kit').terminal,
	guid : require('uuid/v4')
};

process.on('unhandledRejection', (reason) => {
	app.term('\n\n').bgRed('Promise Error:').defaultColor('\n');
	console.log(reason);
	app.term('\n\n');
});

function forwarderParamParser(params) {
	if (params.length < 2) return console.log('Insufficient arguments for -L');
	if (params.length === 2) return {localIp: '127.0.0.1', localPort: params[0], remoteIp: '127.0.0.1', remotePort: params[1]};
	if (params.length === 3) return {localIp: '127.0.0.1', localPort: params[0], remoteIp: params[1], remotePort: params[2]};
	return {localIp: params[0], localPort: params[1], remoteIp: params[2], remotePort: params[3]};
}

function runInForwarder(link) {
	let params = forwarderParamParser(app.argv.L.split(':'));
	if (!params) return;
	app.ssh.newInForwarder(link, params.remoteIp, params.remotePort, params.localIp, params.localPort);
}

function runOutForwarder(link) {
	let params = forwarderParamParser(app.argv.R.split(':'));
	if (!params) return;
	app.ssh.newOutForwarder(link, params.localIp, params.localPort, params.remoteIp, params.remotePort);
}

function readPassword(username) {
	return new Promise((resolve) => {
		app.term(`Please enter password for '${username}': `);
		app.term.inputField({}, function(err, input) {
			resolve(input);
			app.term('\n\n');
		}).hide();


//		rl.question(, (answer) => {

	});
}

(async () => {
	app.quit = (msg, code = 1) => {
		(code > 0 ? app.term.red : app.term)(msg);
		process.exit(code);
	};

	app.term.eraseLine();

	await require('./libs/ssh')(app);
	let connArr;
	if (!app.argv._[0] || (connArr = app.argv._[0].split('@')).length !== 2) {
		app.quit('Can\' connect, missing "user@server" in arguments');
	}

	let connectionParams = {
		host    : connArr[1],
		port    : parseInt(app.argv.p) || 22,
		username: connArr[0]
	};
	if (app.argv.i) {
		if (!await app.fs.exists(app.argv.i)) { app.quit('Can\'t find RSA key'); }
		Object.assign(connectionParams, {privateKey: await app.fs.readFile(app.argv.i)});
	} else {
		Object.assign(connectionParams, {password: await readPassword(connectionParams.username)});
	}

	app.stdin.setRawMode(true);
	app.stdin.setEncoding('utf8');

	const readline = require('readline');
	readline.emitKeypressEvents(process.stdin);
	process.stdin.setRawMode(true);

	let sshConnection = await app.ssh.newConnection(connectionParams);
	if (!sshConnection.result) return console.log(sshConnection.error);

	let sshShell = await app.ssh.newShell(sshConnection.link);
	if (!sshShell.result) return console.log(sshShell.error);

	if (app.argv.L) runInForwarder(sshConnection.link);
	if (app.argv.R) runOutForwarder(sshConnection.link);

	await app.ssh.newTerminal(sshShell.stream, sshConnection.link, connectionParams.username);

	process.stdin.on('keypress', (str, key) => {
		if (key.ctrl && key.name === 'q') { process.exit(); }
	});
})();