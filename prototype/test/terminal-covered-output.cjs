const { existsSync } = require('node:fs');

process.stdout.write('\x1b[32mspan_covered_ready\x1b[0m\r\n');
const gate = setInterval(() => {
  if (!existsSync(process.argv[2])) return;
  clearInterval(gate);
  let line = 0;
  const output = setInterval(() => {
    process.stdout.write(`\x1b[90mspan_hidden_${String(++line).padStart(3, '0')}\x1b[0m\r\n`);
    if (line === 80) {
      clearInterval(output);
      process.stdout.write('\x1b[32mspan_covered_done\x1b[0m\r\n');
    }
  }, 45);
}, 20);
