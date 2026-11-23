import { memo, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { SquareTerminal, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

let generation = 0;

export const TerminalPanel = memo(function TerminalPanel({ workspace, ssh, onClose }) {
  const element = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const host = element.current;
    const source = ++generation;
    const terminal = new Terminal({
      scrollback: 2000,
      fontFamily: 'Cascadia Mono, Consolas, Liberation Mono, monospace',
      fontSize: 13,
      theme: {
        background: '#13151a', foreground: '#d2d9e5',
        cursor: '#9abaff', selectionBackground: '#375584',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    let closed = false;
    host.dataset.renderer = 'dom';
    import('@xterm/addon-webgl').then(({ WebglAddon }) => {
      if (closed) return;
      const webgl = new WebglAddon();
      try {
        terminal.loadAddon(webgl);
      } catch {
        webgl.dispose();
        return;
      }
      host.dataset.renderer = 'webgl';
      fit.fit();
      webgl.onContextLoss(() => {
        webgl.dispose();
        host.dataset.renderer = 'dom';
        fit.fit();
      });
    }).catch(() => {
      // The DOM renderer is already active if the optional addon cannot load.
    });
    const update = (method, params) => window.span.request('terminal.' + method, {
      ...params, generation: source,
    }).catch(error => {
      if (!closed) setError(error.message);
    });
    const unsubscribe = window.span.onEvent(packet => {
      if (packet.generation !== source) return;
      if (packet.event === 'terminal') {
        const raw = atob(packet.data);
        terminal.write(Uint8Array.from(raw, character => character.charCodeAt(0)));
      }
      if (packet.event === 'terminal-closed') terminal.writeln('\r\n[终端已退出]');
    });
    update('start', { cwd: workspace, ssh, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData(data => update('write', { data }));
    const size = terminal.onResize(value => update('resize', value));
    let frame;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fit.fit());
    });
    observer.observe(host);
    return () => {
      closed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      size.dispose();
      terminal.dispose();
      update('close', {});
    };
  }, [workspace, ssh]);
  return <section className="terminal-panel" aria-label="终端">
    <header><SquareTerminal size={16} /> <strong>终端</strong><span>{ssh || '本地'}</span>
      <button className="icon-button right" title="关闭终端" onClick={onClose}><X size={16} /></button>
    </header>
    {error && <div role="alert" className="terminal-error">{error}</div>}
    <div className="terminal-canvas" ref={element} />
  </section>;
});
