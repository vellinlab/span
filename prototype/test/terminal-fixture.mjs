export const burstMarker = 'span_pressure_done';

export function terminalBurst(windows, short = false) {
  const line = 'span-pressure '.repeat(6).trimEnd();
  if (!windows) {
    return `yes '${line}' | head -c ${short ? 655360 : 4194304}; printf '\\n%s_%s\\n' span_pressure done`;
  }
  // ConPTY can coalesce a screenful of repeated writes. Distinct rows and short pauses give it time to emit them.
  const batches = short ? 340 : 580;
  return `powershell -NoLogo -NoProfile -Command "for ($i=0; $i -lt ${batches}; $i++) { `
    + `for ($j=0; $j -lt 16; $j++) { [Console]::WriteLine(($i.ToString()+'-'+$j+' ${line}')) }; `
    + `Start-Sleep -Milliseconds 18 }; [Console]::WriteLine(('span_pressure_'+'done'))"`;
}
