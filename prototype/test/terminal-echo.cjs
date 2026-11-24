// Run inside the packaged preview's PTY so the latency probe includes both IPC directions.
const { stdin, stdout } = process;
stdin.setRawMode(true);
stdin.setEncoding('utf8');
stdin.resume();
let output;
let line = 0;
stdin.on('data', key => {
  if (key === 'q') {
    clearInterval(output);
    stdin.setRawMode(false);
    stdin.pause();
    const final = Buffer.from('绘');
    const windows = process.platform === 'win32';
    const split = windows ? final.length : 1;
    setTimeout(() => {
      stdout.write(windows ? '\x1b[32m' : '\x1b[3');
      setTimeout(() => {
        if (!windows) stdout.write('2m');
        stdout.write(final.subarray(0, split));
        setTimeout(() => {
          stdout.write(final.subarray(split));
          stdout.write('_echo_final\x1b[0m\r\n');
        }, 25);
      }, 25);
    }, 170);
    return;
  }
  stdout.write(`span_echo_${key}\r\n`);
  if (key === 'g') {
    output = setInterval(() => stdout.write(`span_interaction_${++line}\r\n`), 45);
  }
});
stdout.write('span_echo_ready\r\n');
