import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { SquareTerminal, X } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import { observeWindowHidden } from './window-visibility.js';

let generation = Math.trunc(performance.timeOrigin * 1_000);
const ACK_BYTES = 64 * 1024;
const OUTPUT_GAP_MS = 96;
const OUTPUT_BATCH_MS = 64;
const INPUT_PRIORITY_MS = 140;

export const TerminalPanel = memo(function TerminalPanel({ workspace, ssh, renderer, covered, onClose }) {
  const element = useRef(null);
  const hidden = useRef(covered);
  const applyRenderVisibility = useRef(null);
  const [error, setError] = useState('');
  useLayoutEffect(() => observeWindowHidden(windowHidden => {
    const paused = covered || windowHidden;
    if (hidden.current === paused) return;
    hidden.current = paused;
    applyRenderVisibility.current?.();
  }), [covered]);
  useEffect(() => {
    setError('');
    const host = element.current;
    const source = ++generation;
    const terminal = new Terminal({
      scrollback: 2000,
      fontFamily: 'Cascadia Mono, Consolas, Liberation Mono, monospace',
      fontSize: 13,
      minimumContrastRatio: 4.5,
      theme: {
        background: '#151617', foreground: '#dedede',
        cursor: '#bdd8c6', selectionBackground: '#43554b',
        black: '#262b2d', red: '#e17f79', green: '#9ecb9a', yellow: '#d7bd7c',
        blue: '#82acf0', magenta: '#b59acf', cyan: '#82c3c7', white: '#d6dcda',
        brightBlack: '#808b8e', brightRed: '#ffaba4', brightGreen: '#bee7b4', brightYellow: '#f1d89d',
        brightBlue: '#a9c9f8', brightMagenta: '#d7b4ec', brightCyan: '#afe0e0', brightWhite: '#f1f5f2',
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fit.fit();
    let frame;
    let fitPending = false;
    // Keep the PTY at its last visible size until the terminal is revealed.
    const fitWhenVisible = () => {
      fitPending = hidden.current;
      if (!fitPending) fit.fit();
    };
    const renderService = terminal._core?._renderService;
    let intersection = { isIntersecting: true };
    const outsideViewport = { isIntersecting: false };
    const setIntersection = typeof renderService?._handleIntersectionChange === 'function'
      ? renderService._handleIntersectionChange.bind(renderService) : undefined;
    if (setIntersection) {
      // Electron window visibility can change without changing the terminal's intersection.
      renderService._handleIntersectionChange = entry => {
        intersection = entry;
        if (!hidden.current) setIntersection(entry);
      };
      if (typeof renderService._renderRows === 'function') {
        const drawRows = renderService._renderRows.bind(renderService);
        renderService._renderRows = (start, end) => {
          // A frame can already be queued when the window is hidden.
          if (hidden.current) terminal.refresh(start, end);
          else drawRows(start, end);
        };
      }
    }
    // xterm 6 redraws all DOM rows for a selection refresh, including on buffer scroll.
    let restoreSelection;
    if (typeof renderService?.handleSelectionChanged === 'function') {
      const refreshSelection = renderService.handleSelectionChanged.bind(renderService);
      let selectionDrawn = false;
      const drawSelection = (start, end, columnSelectMode) => {
        const selected = Boolean(start && end && (start[0] !== end[0] || start[1] !== end[1]));
        if (!selected && !selectionDrawn) return;
        refreshSelection(selected ? start : undefined, selected ? end : undefined, columnSelectMode);
        selectionDrawn = selected;
      };
      let deferredSelection;
      renderService.handleSelectionChanged = (...selection) => {
        if (hidden.current) deferredSelection = selection;
        else drawSelection(...selection);
      };
      restoreSelection = () => {
        if (!deferredSelection) return;
        drawSelection(...deferredSelection);
        deferredSelection = undefined;
      };
    }
    applyRenderVisibility.current = () => {
      if (!hidden.current && fitPending) fitWhenVisible();
      setIntersection?.(hidden.current ? outsideViewport : intersection);
      if (!hidden.current) restoreSelection?.();
    };
    if (hidden.current) applyRenderVisibility.current();
    let closed = false;
    host.dataset.renderer = 'dom';
    if (renderer !== 'dom') {
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
        flushOutput();
        fitWhenVisible();
        webgl.onContextLoss(() => {
          webgl.dispose();
          host.dataset.renderer = 'dom';
          fitWhenVisible();
        });
      }).catch(() => {
        // The DOM renderer is already active if the optional addon cannot load.
      });
    }
    const update = (method, params) => window.span.request('terminal.' + method, {
      ...params, generation: source,
    }).catch(error => {
      if (!closed) setError(error.message);
    });
    let unacknowledged = 0;
    let lastOutput = -Infinity;
    let prioritizeInputUntil = 0;
    let outputTimer;
    let queuedOutput = [];
    let queuedBytes = 0;
    const writeOutput = bytes => {
      unacknowledged += bytes.length;
      if (unacknowledged < ACK_BYTES) {
        terminal.write(bytes);
        return;
      }
      const processed = unacknowledged;
      unacknowledged = 0;
      terminal.write(bytes, () => { if (!closed) update('ack', { bytes: processed }); });
    };
    function flushOutput() {
      if (!queuedBytes) return;
      clearTimeout(outputTimer);
      outputTimer = undefined;
      let batch = queuedOutput[0];
      if (queuedOutput.length > 1) {
        batch = new Uint8Array(queuedBytes);
        let offset = 0;
        for (const bytes of queuedOutput) {
          batch.set(bytes, offset);
          offset += bytes.length;
        }
      }
      queuedOutput = [];
      queuedBytes = 0;
      writeOutput(batch);
    }
    const unsubscribe = window.span.onEvent(packet => {
      if (packet.generation !== source) return;
      if (packet.event === 'terminal') {
        const bytes = Uint8Array.fromBase64(packet.data);
        const now = performance.now();
        const continuous = now - lastOutput < OUTPUT_GAP_MS;
        lastOutput = now;
        // Show the first output and interactive echo immediately. Coalesce only continuous DOM output.
        const immediate = !continuous || now < prioritizeInputUntil || host.dataset.renderer === 'webgl';
        if (immediate && !queuedBytes) {
          writeOutput(bytes);
        } else {
          queuedOutput.push(bytes);
          queuedBytes += bytes.length;
          // xterm can parse the first write after a key synchronously. Include the reply in that write.
          if (immediate || queuedBytes >= ACK_BYTES) flushOutput();
          else outputTimer ??= setTimeout(flushOutput, OUTPUT_BATCH_MS);
        }
      }
      if (packet.event === 'terminal-closed') {
        flushOutput();
        terminal.writeln('\r\n[终端已退出]');
      }
      if (packet.event === 'terminal-error') setError(packet.data);
    }, { events: ['terminal', 'terminal-closed', 'terminal-error'], generation: source });
    update('start', { cwd: workspace, ssh, cols: terminal.cols, rows: terminal.rows });
    const input = terminal.onData(data => {
      // Send input before parsing queued output. Its response can arrive in the same paint as that output.
      prioritizeInputUntil = performance.now() + INPUT_PRIORITY_MS;
      update('write', { data });
    });
    const size = terminal.onResize(value => update('resize', value));
    const observer = new ResizeObserver(() => {
      fitPending = true;
      if (hidden.current || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (fitPending) fitWhenVisible();
      });
    });
    observer.observe(host);
    return () => {
      closed = true;
      applyRenderVisibility.current = null;
      clearTimeout(outputTimer);
      queuedOutput = [];
      cancelAnimationFrame(frame);
      observer.disconnect();
      unsubscribe();
      input.dispose();
      size.dispose();
      terminal.dispose();
      update('close', {});
    };
  }, [workspace, ssh, renderer]);
  return <section className="terminal-panel" aria-label="终端">
    <header><SquareTerminal size={16} /> <strong>终端</strong><span>{ssh || '本地'}</span>
      <button className="icon-button right" title="关闭终端" onClick={onClose}><X size={16} /></button>
    </header>
    {error && <div role="alert" className="terminal-error">{error}</div>}
    <div className="terminal-canvas" ref={element} />
  </section>;
});
