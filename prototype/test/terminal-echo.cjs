// Run inside the packaged preview's PTY so the latency probe includes both IPC directions.
const { stdin, stdout } = process;
stdin.setRawMode(true);
stdin.setEncoding('utf8');
stdin.resume();
let output;
let line = 0;
// Keep the echo in one place while progress refreshes other rows of the terminal.
stdout.write('\x1b[?1049h');
const echo = key => stdout.write(`\x1b[1;1Hspan_echo_${key}\x1b[K\x1b[2;1H`);
stdin.on('data', key => {
  if (key === 'f') {
    clearInterval(output);
    stdout.write(`\x1b[${stdout.rows};1H\x1b[2K\x1b[32m绘_echo_final\x1b[0m`);
    return;
  }
  if (key === 'q') {
    clearInterval(output);
    stdin.setRawMode(false);
    stdin.pause();
    const windows = process.platform === 'win32';
    stdout.write('\x1b[?1049l');
    if (windows) return;
    const final = Buffer.from('绘');
    setTimeout(() => {
      stdout.write('\x1b[3');
      setTimeout(() => {
        stdout.write('2m');
        stdout.write(final.subarray(0, 1));
        setTimeout(() => {
          stdout.write(final.subarray(1));
          stdout.write('_echo_final\x1b[0m\r\n');
        }, 25);
      }, 25);
    }, 170);
    return;
  }
  echo(key);
  if (key === 'g') {
    const progressRows = Math.max(1, stdout.rows - 2);
    output = setInterval(() => {
      const row = 2 + line % progressRows;
      stdout.write(`\x1b[${row};1Hspan_interaction_${++line}\x1b[K`);
    }, 45);
  }
});
echo('ready');
