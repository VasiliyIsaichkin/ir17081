module.exports = async (app) => {
	app.ssh = {
		newConnection     : (params) => new Promise((resolve) => {
			let link = require('ssh2').Client();
			link.on('error', (error) => resolve({
				    result: false,
				    error,
				    link
			    }))
			    .on('ready', () => resolve({
				    result: true,
				    link
			    }))
			    .connect(params);
		}),
		newShell          : (link) => new Promise(((resolve) => {
			link.shell({term: 'xterm'}, (error, stream) => {
				if (error) return resolve({
					result: false,
					error,
					stream
				});

				resolve({
					result: true,
					stream
				});
			});
		})),
		newTerminal       : (shellStream, link, username) => {
			let screenBuffer = '';
			let cmdGetOpen = app.guid();
			let cmdPutOpen = app.guid();
			let cmdClose = app.guid();
			//@todo: rework this for os-independent
			let cmdAlias = ` get () { echo ${cmdGetOpen} \`pwd\` $1 ; }; put () { echo ${cmdPutOpen} \`pwd\` $1 ; }; #${cmdClose}`;
			let injectStep = 1;

			shellStream
				.on('close', () => {
					link.end();
					process.exit();
				})
				.on('data', async (data) => {
					let dataStr = data.toString();
					screenBuffer += dataStr.replace(/[^A-Za-z0-9\.,\?""!@#\$%\^&\*\(\)-_=\+;:<>\/\\\|\}\{\[\]`~]*/g, ''); //clear control-symbols

					//@todo: rework this for os/shell-independent
					if (injectStep === 1 && dataStr.includes(`${username}@`)) {
						shellStream.write(`${cmdAlias}\n`);
						injectStep = 2;
					}
					if (injectStep === 2) {
						if (screenBuffer.includes(cmdClose)) {
							screenBuffer = '';
							injectStep = 0;
						}
						return;
					}

					let currCmd = dataStr.includes(cmdGetOpen) ? 'get' : dataStr.includes(cmdPutOpen) ? 'put' : false;
					if (currCmd) {
						await app.ssh.cmdHandler(currCmd, dataStr, link);
						return;
					}

					if (screenBuffer.length > 8192) { screenBuffer.truncate(data.toString().length, 'left', ''); }
					app.term(data);
				})
				.stderr.on('data', (data) => { app.term(data); });

			process.stdin.on('keypress', (str, key) => {
				if (injectStep !== 0) return;
				shellStream.write(key.sequence);
			});
		},
		newSftp           : (link) => new Promise(resolve => {
			link.sftp(function(error, stream) {
				if (error) return resolve({
					result: false,
					error,
					stream
				});

				resolve({
					result: true,
					stream
				});
			});
		}),
		newSftpTransmitter: (from, to, size, onUpdate) => new Promise(resolve => {
			let progress = require('progress-stream');
			let progressor = progress({length: size, time: 500});

			progressor.on('progress', (progress) => { if (onUpdate) onUpdate(progress); });

			to.on('close', () => { resolve({result: true}); })
			  .on('error', (error) => { resolve({result: false, error});});

			from.pipe(progressor)
			    .pipe(to);
		}),
		newOutForwarder   : (link, localIp, localPort, remoteIp, remotePort) => new Promise((resolve) => {
			let net = require('net');
			net.createServer(function(sock) {
				link.forwardOut(sock.remoteAddress, sock.remotePort, remoteIp, remotePort, function(error, stream) {
					if (error) resolve({result: false, error});
					sock.pipe(stream);
					stream.pipe(sock);
					resolve({result: true, stream});
				});
			}).listen(localPort, localIp);
		}),
		newInForwarder    : (link, remoteIp, remotePort, localIp, localPort) => {
			let client = new require('net').Socket();
			link.forwardIn(remoteIp, remotePort, () => {
				link.on('tcp connection', (info, accept) => {
					let stream = accept();
					client.connect(localPort, localIp, () => {
						stream.pipe(client);
						client.pipe(stream);
					});
				});
			});
		},
		cmdHandler        : async (cmd, dataStr, link) => {
			function updateStatus(cb) {
				app.term.saveCursor();
				app.term.move(-100, -2).eraseLine();
				cb();
				app.term.restoreCursor();
			}

			function updateProgress(title, stats) {
				updateStatus(() => app.term(`${title}: ${Number((stats.percentage).toFixed(1))}% (${
					Math.round(stats.transferred / 1024)} kb), ETA: ${
					stats.eta} s, speed: ${Math.round(stats.speed / 1024)} kb/s`));
			}

			function fileOpen(source, path, mode = 'r') {
				return new Promise(resolve => source.open(path, mode, (err, fd) => { resolve(err ? false : fd); }));
			}

			function fileSize(source, fd) {
				return new Promise(resolve => source.fstat(fd, (err, stats) => resolve(err ? false : stats)));
			}

			let cmdArr = dataStr.split(' ');
			if (!cmdArr[2]) return;
			app.term(`Preparing for file ${cmd === 'get' ? 'downloading' : 'uploading'}...\n`);

			let sftpHandle = await app.ssh.newSftp(link);
			if (!sftpHandle.result) return app.term(sftpHandle.error);

			let transmitter, pathFrom, pathTo, sizeFd;

			if (cmd === 'get') {
				// get command
				pathFrom = cmdArr[2][0] === '/' ? cmdArr[2] : `${cmdArr[1]}/${cmdArr[2]}`;
				pathTo = cmdArr[2].split('/').last();

				if (!(sizeFd = await fileOpen(sftpHandle.stream, pathFrom, 'r'))) return updateStatus(() => app.term.red('Can\'t read to remote-side file'));
				if (!await fileOpen(require('fs'), pathTo, 'w')) return updateStatus(() => app.term.red('Can\'t write to local-side file'));

				transmitter = await app.ssh.newSftpTransmitter(
					sftpHandle.stream.createReadStream(pathFrom),
					app.fs.createWriteStream(pathTo),
					(await fileSize(sftpHandle.stream, sizeFd)).size, (stats) => updateProgress('Downloading', stats));
			} else {
				// put command
				pathFrom = `${process.cwd()}/${cmdArr[2]}`;
				pathTo = `${cmdArr[1]}/${cmdArr[2].split('/').last()}`;

				if (!await fileOpen(sftpHandle.stream, pathTo, 'w')) return updateStatus(() => app.term.red('Can\'t write to remote-side file'));
				if (!(sizeFd = await fileOpen(require('fs'), pathFrom, 'r'))) return updateStatus(() => app.term.red('Can\'t read to local-side file'));

				transmitter = await app.ssh.newSftpTransmitter(
					app.fs.createReadStream(pathFrom),
					sftpHandle.stream.createWriteStream(pathTo),
					(await fileSize(require('fs'), sizeFd)).size, (stats) => updateProgress('Uploading', stats));
			}
			if (!transmitter.result) return app.term(transmitter.error);
			updateStatus(() => app.term('Successful!'));

		}
	};
};